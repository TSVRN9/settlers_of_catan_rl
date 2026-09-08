/*
 * Catan RL bridge bot for JSettlers (docs/BENCHMARK.md Phase B).
 * Copyright (C) 2026 the settlers_of_catan_rl authors.
 *
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 3 of the
 * License, or (at your option) any later version. It links against JSettlers2 (GPL-3).
 */
package catanrl;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.util.ArrayList;
import java.util.List;

import soc.game.SOCBoard;
import soc.game.SOCCity;
import soc.game.SOCDevCardConstants;
import soc.game.SOCGame;
import soc.game.SOCInventory;
import soc.game.SOCPlayer;
import soc.game.SOCPlayingPiece;
import soc.game.SOCResourceConstants;
import soc.game.SOCResourceSet;
import soc.game.SOCRoutePiece;
import soc.game.SOCSettlement;
import soc.game.SOCTradeOffer;
import soc.message.SOCGameStats;
import soc.message.SOCMakeOffer;
import soc.message.SOCMessage;
import soc.message.SOCRejectOffer;
import soc.robot.DiscardStrategy;
import soc.robot.MonopolyStrategy;
import soc.robot.OpeningBuildStrategy;
import soc.robot.SOCPlayerTracker;
import soc.robot.SOCPossibleCity;
import soc.robot.SOCPossibleRoad;
import soc.robot.SOCPossibleSettlement;
import soc.robot.RobberStrategy;
import soc.robot.SOCBuildPlan;
import soc.robot.SOCBuildPlanStack;
import soc.robot.SOCPossibleCard;
import soc.robot.SOCPossibleCity;
import soc.robot.SOCPossibleRoad;
import soc.robot.SOCPossibleSettlement;
import soc.robot.SOCRobotBrain;
import soc.robot.SOCRobotClient;
import soc.robot.SOCRobotDM;
import soc.robot.SOCRobotNegotiator;
import soc.util.CappedQueue;
import soc.util.SOCRobotParameters;

/**
 * SOCRobotBrain whose decisions come from jsettlers_server.py over a pipe. The stock brain keeps its
 * turn state machine; this class only answers the questions it asks at its decision hooks:
 * <ul>
 * <li>{@code full} mode: opening placements ({@link OpeningBuildStrategy}), roll-or-knight
 *     ({@link #rollOrPlayKnightOrExpectDice()}), the main-phase action ({@link SOCRobotDM#planStuff(int)}:
 *     a build becomes a one-piece plan the brain then requests; dev cards, bank trades and offers are sent
 *     here directly and the brain re-plans afterwards; no plan ends the turn), robber hex and victim
 *     ({@link RobberStrategy}), discards ({@link DiscardStrategy}), monopoly and year-of-plenty picks, and
 *     replies to offers ({@link #considerOffer(SOCTradeOffer)}).</li>
 * <li>{@code trades} mode: only {@link #makeOffer(SOCBuildPlan)}, {@link #considerOffer(SOCTradeOffer)} and
 *     {@link #makeCounterOffer(SOCTradeOffer)} (never counters); everything else is the stock brain. With
 *     {@code bridge.player=drrl} this is the paper's DRRL-over-jSettler setup.</li>
 * <li>{@code log} mode: the stock brain plays and every decision hook is logged with the state and the
 *     tracker's ETAs to {@code bridge.oracle} (default data/jsettlers_oracle), one JSON line each.</li>
 * </ul>
 * Any {@code ERROR} reply falls back to the stock behaviour for that hook. Game results go to
 * {@code bridge.results}, one line per game: {@code game ourPn winnerPn scores... names...}.
 */
public class BridgeBrain extends SOCRobotBrain
{
    private final boolean full = BridgeClient.MODE.equals("full");
    /** {@code log} mode: the stock brain plays, every decision hook appends {state, hook, chosen, ETAs} to
     *  {@code bridge.oracle}/<game>.jsonl, the replay oracle for the jsettler.rs port (BENCHMARK.md Phase E). */
    private final boolean oracle = BridgeClient.MODE.equals("log");
    private Decider decider;
    private boolean boardSent;
    private int pendingVictim = -1;
    private int pendingMono = SOCResourceConstants.WOOD;
    private boolean movingKnight;
    private String[] cachedPlay1; // a PLAY_TURN answer asked by the knight check, consumed by planStuff
    /** Offers made this turn (JSettlers order, give then get): the engine's spent-offer rule, so a rejected offer is not repeated. */
    private final List<int[]> spentOffers = new ArrayList<>();
    /** Every piece the trackers saw, in server order: type, player, coord, game state (for the jsettler port's trackers). */
    private final List<int[]> pieceLog = new ArrayList<>();
    private static final boolean TRACE = Boolean.getBoolean("bridge.trace");
    private String lastRequest, lastReply, lastBoard; // for the dump when the server rejects a placement

    public BridgeBrain(SOCRobotClient rc, SOCRobotParameters params, SOCGame ga, CappedQueue<SOCMessage> mq)
    {
        super(rc, params, ga, mq);
    }

    // ---------------------------------------------------------------- the decision server

    /** One python process per client (BridgeClient.decider()); JSON lines out, one reply line in. */
    static final class Decider
    {
        final Process proc;
        final BufferedWriter out;
        final BufferedReader in;

        Decider() throws IOException
        {
            List<String> cmd = new ArrayList<>();
            for (String s : System.getProperty("bridge.python", "uv run --no-sync python jsettlers_server.py").split(" "))
                cmd.add(s);
            cmd.add("--player");
            cmd.add(BridgeClient.PLAYER);
            ProcessBuilder pb = new ProcessBuilder(cmd).directory(new File(BridgeClient.REPO)).redirectError(ProcessBuilder.Redirect.INHERIT);
            proc = pb.start();
            out = new BufferedWriter(new OutputStreamWriter(proc.getOutputStream(), "UTF-8"));
            in = new BufferedReader(new InputStreamReader(proc.getInputStream(), "UTF-8"));
        }

        synchronized String ask(String json) throws IOException
        {
            out.write(json);
            out.newLine();
            out.flush();
            String line = in.readLine();
            if (line == null)
                throw new IOException("decision server exited");
            return line;
        }
    }

    private void ensureServer() throws IOException
    {
        if (decider == null)
            decider = ((BridgeClient) client).decider();
        if (! boardSent)
        {
            lastBoard = boardJson();
            if (TRACE)
                System.err.println("bridge " + ourPlayerName + " board " + lastBoard);
            String r = decider.ask(lastBoard);
            if (! r.equals("OK"))
                throw new IOException(r);
            boardSent = true;
        }
    }

    /** The board message: land hexes (coord, type, number) and ports (type, node, node). */
    private String boardJson()
    {
        {
            SOCBoard b = game.getBoard();
            StringBuilder sb = new StringBuilder("{\"op\":\"board\",\"n\":").append(game.maxPlayers).append(",\"ourPn\":").append(ourPlayerNumber).append(",\"hexes\":[");
            boolean first = true;
            for (int hex : b.getLandHexCoords())
            {
                sb.append(first ? "" : ",").append('[').append(hex).append(',').append(b.getHexTypeFromCoord(hex)).append(',').append(b.getNumberOnHexFromCoord(hex)).append(']');
                first = false;
            }
            sb.append("],\"ports\":[");
            int[] edges = b.getPortsEdges();
            for (int i = 0; i < edges.length; ++i)
            {
                int[] nodes = b.getAdjacentNodesToEdge_arr(edges[i]);
                // classic-board ports are encoded in the hex layout; the per-node lookup works for every encoding
                sb.append(i == 0 ? "" : ",").append('[').append(b.getPortTypeFromNodeCoord(nodes[0])).append(',').append(nodes[0]).append(',').append(nodes[1]).append(']');
            }
            sb.append("]}");
            return sb.toString();
        }
    }

    /** Ask for a decision; null when the server failed (the caller falls back to the stock brain). */
    private String[] ask(String prompt, String extra)
    {
        try
        {
            ensureServer();
            StringBuilder sb = new StringBuilder("{\"op\":\"decide\",\"prompt\":\"").append(prompt).append("\",\"knight\":").append(movingKnight).append(",\"state\":");
            stateJson(sb);
            if (extra != null)
                sb.append(',').append(extra);
            sb.append('}');
            String r = decider.ask(sb.toString());
            lastRequest = sb.toString();
            lastReply = r;
            if (TRACE)
                System.err.println("bridge " + ourPlayerName + " " + prompt + " -> " + r);
            if (r.startsWith("ERROR"))
            {
                System.err.println("bridge " + ourPlayerName + ": " + r);
                return null;
            }
            return r.split(" ");
        }
        catch (IOException | RuntimeException e)
        {
            System.err.println("bridge " + ourPlayerName + ": " + e);
            e.printStackTrace();
            return null;
        }
    }

    private static int num(String[] r, int i)
    {
        return Integer.parseInt(r[i]);
    }

    /** catanatron's turn counter: initial placements count one per road placed, then one per turn. */
    private int turns()
    {
        if (game.getGameState() < SOCGame.ROLL_OR_CARD)
        {
            int roads = 0;
            for (int pn = 0; pn < game.maxPlayers; ++pn)
                roads += game.getPlayer(pn).getRoadsAndShips().size();
            return roads;
        }
        int n = game.maxPlayers;
        return 2 * n + (game.getRoundCount() - 1) * n + ((game.getCurrentPlayerNumber() - game.getFirstPlayer() + n) % n);
    }

    private static void devCounts(StringBuilder sb, SOCInventory inv, int[] states)
    {
        sb.append('{');
        boolean first = true;
        for (int t = 1; t <= 9; ++t)
        {
            int k = 0;
            for (int st : states)
                k += inv.getAmountByState(st, t);
            if (k > 0)
            {
                sb.append(first ? "" : ",").append('"').append(t).append("\":").append(k);
                first = false;
            }
        }
        sb.append('}');
    }

    /** The client's view of the game (jsettlers_server.js_view is the same shape from catanatron). */
    private void stateJson(StringBuilder sb)
    {
        SOCBoard b = game.getBoard();
        SOCPlayer lr = game.getPlayerWithLongestRoad(), la = game.getPlayerWithLargestArmy();
        sb.append("{\"current\":").append(game.getCurrentPlayerNumber()).append(",\"turns\":").append(turns())
          .append(",\"robber\":").append(b.getRobberHex()).append(",\"devDeck\":").append(game.getNumDevCards())
          .append(",\"longestRoad\":").append(lr == null ? -1 : lr.getPlayerNumber())
          .append(",\"largestArmy\":").append(la == null ? -1 : la.getPlayerNumber()).append(",\"pieces\":[");
        for (int i = 0; i < pieceLog.size(); ++i)
        {
            int[] q = pieceLog.get(i);
            sb.append(i == 0 ? "" : ",").append('[').append(q[0]).append(',').append(q[1]).append(',').append(q[2]).append(',').append(q[3]).append(']');
        }
        sb.append("],\"spentOffers\":[");
        for (int i = 0; i < spentOffers.size(); ++i)
        {
            sb.append(i == 0 ? "[" : ",[");
            for (int k = 0; k < 10; ++k)
                sb.append(k == 0 ? "" : ",").append(spentOffers.get(i)[k]);
            sb.append(']');
        }
        sb.append("],\"players\":[");
        for (int pn = 0; pn < game.maxPlayers; ++pn)
        {
            SOCPlayer pl = game.getPlayer(pn);
            SOCResourceSet rs = pl.getResources();
            SOCInventory inv = pl.getInventory();
            sb.append(pn == 0 ? "" : ",").append("{\"res\":[");
            for (int t = SOCResourceConstants.CLAY; t <= SOCResourceConstants.UNKNOWN; ++t)
                sb.append(t == SOCResourceConstants.CLAY ? "" : ",").append(rs.getAmount(t));
            sb.append("],\"devOld\":");
            devCounts(sb, inv, new int[] { SOCInventory.PLAYABLE, SOCInventory.KEPT });
            sb.append(",\"devNew\":");
            devCounts(sb, inv, new int[] { SOCInventory.NEW });
            int unknown = 0;
            for (int st : new int[] { SOCInventory.NEW, SOCInventory.PLAYABLE, SOCInventory.KEPT })
                unknown += inv.getAmountByState(st, SOCDevCardConstants.UNKNOWN);
            sb.append(",\"devUnknown\":").append(unknown).append(",\"played\":{");
            int[] played = new int[10];
            if (pl.getDevCardsPlayed() != null) // null until the first card is played
                for (Integer t : pl.getDevCardsPlayed())
                    if (t >= 0 && t < 10)
                        played[t]++;
            boolean first = true;
            for (int t = 1; t <= 9; ++t)
                if (played[t] > 0)
                {
                    sb.append(first ? "" : ",").append('"').append(t).append("\":").append(played[t]);
                    first = false;
                }
            sb.append("},\"knights\":").append(pl.getNumKnights()).append(",\"vp\":").append(pl.getPublicVP()).append(",\"totalVp\":").append(pl.getTotalVP())
              .append(",\"settlements\":[");
            first = true;
            for (SOCSettlement s : pl.getSettlements())
            {
                sb.append(first ? "" : ",").append(s.getCoordinates());
                first = false;
            }
            sb.append("],\"cities\":[");
            first = true;
            for (SOCCity c : pl.getCities())
            {
                sb.append(first ? "" : ",").append(c.getCoordinates());
                first = false;
            }
            sb.append("],\"roads\":[");
            first = true;
            for (SOCRoutePiece r : pl.getRoadsAndShips())
            {
                int[] nodes = b.getAdjacentNodesToEdge_arr(r.getCoordinates());
                sb.append(first ? "" : ",").append('[').append(nodes[0]).append(',').append(nodes[1]).append(']');
                first = false;
            }
            sb.append("],\"lrLen\":").append(pl.getLongestRoadLength()).append(",\"pieces\":[").append(pl.getNumPieces(SOCPlayingPiece.ROAD)).append(',')
              .append(pl.getNumPieces(SOCPlayingPiece.SETTLEMENT)).append(',').append(pl.getNumPieces(SOCPlayingPiece.CITY)).append("],\"playedDevThisTurn\":")
              .append(pl.hasPlayedDevCard()).append('}');
        }
        sb.append("]}");
    }

    private static String offerJson(SOCTradeOffer offer)
    {
        StringBuilder sb = new StringBuilder("\"offer\":{\"from\":").append(offer.getFrom()).append(",\"give\":[");
        for (int t = SOCResourceConstants.CLAY; t <= SOCResourceConstants.WOOD; ++t)
            sb.append(t == SOCResourceConstants.CLAY ? "" : ",").append(offer.getGiveSet().getAmount(t));
        sb.append("],\"get\":[");
        for (int t = SOCResourceConstants.CLAY; t <= SOCResourceConstants.WOOD; ++t)
            sb.append(t == SOCResourceConstants.CLAY ? "" : ",").append(offer.getGetSet().getAmount(t));
        return sb.append("]}").toString();
    }

    /** A 5-resource JSettlers-ordered count list at r[i..i+5) as a SOCResourceSet. */
    private static SOCResourceSet set5(String[] r, int i)
    {
        return new SOCResourceSet(num(r, i), num(r, i + 1), num(r, i + 2), num(r, i + 3), num(r, i + 4), 0);
    }

    // ---------------------------------------------------------------- the oracle log (log mode)

    private void oracle(String hook, String chosen)
    {
        if (! oracle)
            return;
        try
        {
            if (! boardLogged)
            {
                oracleLine(boardJson() + "\n"); // the oracle's first line: the board the decisions refer to
                boardLogged = true;
            }
            StringBuilder sb = new StringBuilder("{\"hook\":\"").append(hook).append("\",\"chosen\":").append(chosen).append(",\"pn\":").append(ourPlayerNumber).append(",\"gameState\":").append(game.getGameState());
            if (playerTrackers != null)
            {
                sb.append(",\"winGameEta\":[");
                for (int pn = 0; pn < game.maxPlayers; ++pn)
                    sb.append(pn == 0 ? "" : ",").append(playerTrackers[pn] == null ? -1 : playerTrackers[pn].getWinGameETA());
                sb.append("],\"lrEta\":").append(ourPlayerTracker == null ? -1 : ourPlayerTracker.getLongestRoadETA())
                  .append(",\"laEta\":").append(ourPlayerTracker == null ? -1 : ourPlayerTracker.getLargestArmyETA());
            }
            int[] etas = getEstimator(ourPlayerData.getNumbers()).getEstimatesFromNowFast(ourPlayerData.getResources(), ourPlayerData.getPortFlags());
            sb.append(",\"buildingEtas\":[");
            for (int i = 0; i < etas.length; ++i)
                sb.append(i == 0 ? "" : ",").append(etas[i]);
            sb.append("],\"potSets\":").append(new java.util.TreeSet<Integer>(ourPlayerData.getPotentialSettlements()))
              .append(",\"potRoads\":").append(potentialRoads())
              .append(",\"possibles\":[");
            for (int pn = 0; pn < game.maxPlayers; ++pn)
            {
                SOCPlayerTracker tr = (playerTrackers == null) ? null : playerTrackers[pn];
                sb.append(pn == 0 ? "" : ",").append("{\"sets\":[");
                boolean first = true;
                if (tr != null)
                    for (SOCPossibleSettlement ps : tr.getPossibleSettlements().values())
                    {
                        sb.append(first ? "" : ",").append('[').append(ps.getCoordinates()).append(',').append(ps.getNumberOfNecessaryRoads()).append(']');
                        first = false;
                    }
                sb.append("],\"roads\":[");
                first = true;
                if (tr != null)
                    for (SOCPossibleRoad pr : tr.getPossibleRoads().values())
                    {
                        sb.append(first ? "" : ",").append('[').append(pr.getCoordinates()).append(',').append(pr.getNumberOfNecessaryRoads()).append(']');
                        first = false;
                    }
                sb.append("],\"cities\":[");
                first = true;
                if (tr != null)
                    for (SOCPossibleCity pc : tr.getPossibleCities().values())
                    {
                        sb.append(first ? "" : ",").append(pc.getCoordinates());
                        first = false;
                    }
                sb.append("]}");
            }
            sb.append("],\"favorites\":{");
            if (decisionMaker != null)
            {
                SOCPossibleSettlement fs = decisionMaker.getFavoriteSettlement();
                SOCPossibleCity fc = decisionMaker.getFavoriteCity();
                SOCPossibleRoad fr = decisionMaker.getFavoriteRoad();
                soc.robot.SOCPossibleCard card = decisionMaker.getPossibleCard();
                sb.append("\"settlement\":").append(fs == null ? "null" : "[" + fs.getCoordinates() + "," + fs.getScore() + "]")
                  .append(",\"city\":").append(fc == null ? "null" : "[" + fc.getCoordinates() + "," + fc.getScore() + "]")
                  .append(",\"road\":").append(fr == null ? "null" : "[" + fr.getCoordinates() + "," + fr.getScore() + "]")
                  .append(",\"card\":").append(card == null ? "null" : Float.toString(card.getScore()));
            }
            sb.append("},\"state\":");
            stateJson(sb);
            sb.append("}\n");
            oracleLine(sb.toString());
        }
        catch (IOException | RuntimeException e)
        {
            System.err.println("bridge oracle: " + e);
        }
    }

    private boolean boardLogged;

    /** Our potential road edges, sorted (SOCPlayer keeps the set private; isPotentialRoad is public). */
    private java.util.TreeSet<Integer> potentialRoads()
    {
        java.util.TreeSet<Integer> out = new java.util.TreeSet<Integer>();
        for (int e : game.getBoard().initPlayerLegalRoads())
            if (ourPlayerData.isPotentialRoad(e))
                out.add(e);
        return out;
    }

    /** log mode: the trade messages the negotiator's bookkeeping reacts to, in order. */
    private void tradeEvent(String json)
    {
        if (! oracle)
            return;
        try
        {
            oracleLine("{\"trade\":" + json + "}\n");
        }
        catch (IOException e)
        {
            System.err.println("bridge oracle: " + e);
        }
    }

    /** Every mode but log: a trade message the port's negotiator bookkeeps (jsettlers_server.py `trade` op). */
    private void forwardTrade(String json)
    {
        if (oracle)
            return;
        try
        {
            ensureServer();
            decider.ask("{\"op\":\"trade\"," + json + "}");
        }
        catch (IOException e)
        {
            System.err.println("bridge: " + e);
        }
    }

    @Override
    protected void handleMAKEOFFER(SOCMakeOffer mes)
    {
        SOCTradeOffer o = mes.getOffer();
        if (o.getFrom() != ourPlayerNumber)
        {
            StringBuilder sb = new StringBuilder("{\"kind\":\"offer\",").append(offerJson(o)).append(",\"to\":[");
            boolean[] to = o.getTo();
            for (int pn = 0; pn < to.length; ++pn)
                sb.append(pn == 0 ? "" : ",").append(to[pn]);
            tradeEvent(sb.append("]}").toString());
            StringBuilder fw = new StringBuilder("\"kind\":\"offer\",\"from\":").append(o.getFrom()).append(",\"give\":").append(set(o.getGiveSet())).append(",\"get\":").append(set(o.getGetSet())).append(",\"to\":[");
            for (int pn = 0; pn < to.length; ++pn)
                fw.append(pn == 0 ? "" : ",").append(to[pn]);
            forwardTrade(fw.append(']').toString());
        }
        super.handleMAKEOFFER(mes);
    }

    @Override
    protected void handleREJECTOFFER(SOCRejectOffer mes)
    {
        tradeEvent("{\"kind\":\"reject\",\"pn\":" + mes.getPlayerNumber() + ",\"reason\":" + mes.getReasonCode() + ",\"waiting\":" + waitingForTradeResponse + "}");
        if ((mes.getPlayerNumber() >= 0) && (mes.getReasonCode() == 0))
            forwardTrade("\"kind\":\"reject\",\"pn\":" + mes.getPlayerNumber());
        super.handleREJECTOFFER(mes);
    }

    @Override
    protected void handleTradeResponse(final int toPlayerNum, final boolean accepted)
    {
        tradeEvent("{\"kind\":\"response\",\"pn\":" + toPlayerNum + ",\"accepted\":" + accepted + "}");
        super.handleTradeResponse(toPlayerNum, accepted);
    }

    @Override
    protected void tradeStopWaitingClearOffer()
    {
        tradeEvent("{\"kind\":\"noresponse\",\"waiting\":" + waitingForTradeResponse + "}");
        super.tradeStopWaitingClearOffer();
    }

    /** log mode: every piece the trackers see, in server order, so the port can replay them. */
    @Override
    public void handlePUTPIECE_updateTrackers(final int pn, final int coord, final int pieceType)
    {
        pieceLog.add(new int[] { pieceType, pn, coord, game.getGameState() });
        if (oracle)
        {
            try
            {
                if (! boardLogged)
                {
                    oracleLine(boardJson() + "\n");
                    boardLogged = true;
                }
                oracleLine("{\"piece\":[" + pieceType + "," + pn + "," + coord + "],\"gameState\":" + game.getGameState() + "}\n");
            }
            catch (IOException e)
            {
                System.err.println("bridge oracle: " + e);
            }
        }
        super.handlePUTPIECE_updateTrackers(pn, coord, pieceType);
    }

    private void oracleLine(String line) throws IOException
    {
        File dir = new File(System.getProperty("bridge.oracle", "data/jsettlers_oracle"));
        dir.mkdirs();
        try (FileWriter w = new FileWriter(new File(dir, game.getName().replace('~', '_') + ".jsonl"), true))
        {
            w.write(line);
        }
    }

    private static String plan(SOCBuildPlanStack plan)
    {
        if (plan.isEmpty())
            return "null";
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < plan.getPlanDepth(); ++i)
        {
            soc.robot.SOCPossiblePiece p = plan.getPlannedPiece(i);
            sb.append(i == 0 ? "" : ",").append('[').append(p.getType()).append(',').append(p.getCoordinates()).append(']');
        }
        return sb.append(']').toString();
    }

    private static String set(SOCResourceSet rs)
    {
        StringBuilder sb = new StringBuilder("[");
        for (int t = SOCResourceConstants.CLAY; t <= SOCResourceConstants.WOOD; ++t)
            sb.append(t == SOCResourceConstants.CLAY ? "" : ",").append(rs.getAmount(t));
        return sb.append(']').toString();
    }

    @Override
    protected void planBuilding()
    {
        super.planBuilding();
        oracle("planBuilding", plan(buildingPlan));
    }

    // ---------------------------------------------------------------- trades (both modes)

    @Override
    protected int considerOffer(SOCTradeOffer offer)
    {
        if (! offer.getTo()[ourPlayerNumber])
            return SOCRobotNegotiator.IGNORE_OFFER;
        SOCPlayer from = game.getPlayer(offer.getFrom());
        if ((from.getCurrentOffer() == null) || (offer != from.getCurrentOffer()))
            return SOCRobotNegotiator.IGNORE_OFFER;
        if (oracle)
        {
            int resp = super.considerOffer(offer);
            oracle("considerOffer", "{" + offerJson(offer) + ",\"response\":" + resp + "}");
            return resp;
        }
        String[] r = ask("DECIDE_TRADE", offerJson(offer));
        if (r == null)
            return super.considerOffer(offer);
        pendingCounter = null;
        if (r[0].equals("COUNTER_OFFER_TRADE"))
        {
            pendingCounter = r;
            return SOCRobotNegotiator.COUNTER_OFFER;
        }
        return r[0].equals("ACCEPT_TRADE") ? SOCRobotNegotiator.ACCEPT_OFFER : SOCRobotNegotiator.REJECT_OFFER;
    }

    /** The counter-offer {@link #considerOffer(SOCTradeOffer)} was given, sent to the offerer only. */
    private String[] pendingCounter;

    @Override
    protected boolean makeCounterOffer(SOCTradeOffer offer)
    {
        if (! oracle)
        {
            if (pendingCounter == null)
                return false;
            String[] r = pendingCounter;
            pendingCounter = null;
            return sendOffer(r, offer.getFrom());
        }
        boolean made = super.makeCounterOffer(offer);
        SOCTradeOffer o = ourPlayerData.getCurrentOffer();
        oracle("makeCounterOffer", made && o != null ? "{\"give\":" + set(o.getGiveSet()) + ",\"get\":" + set(o.getGetSet()) + "}" : "null");
        return made;
    }

    /**
     * Send an OFFER_TRADE reply as our current offer, with the bookkeeping SOCRobotBrain.makeOffer does;
     * {@code toPn} = -1 offers to everyone, else to that player only (a counter-offer).
     */
    private boolean sendOffer(String[] r, int toPn)
    {
        boolean[] to = new boolean[game.maxPlayers];
        for (int pn = 0; pn < game.maxPlayers; ++pn)
            to[pn] = (pn != ourPlayerNumber) && ! game.isSeatVacant(pn) && ((toPn < 0) || (pn == toPn));
        SOCTradeOffer offer = new SOCTradeOffer(game.getName(), ourPlayerNumber, to, set5(r, 1), set5(r, 6));
        int[] spent = new int[10];
        for (int k = 0; k < 10; ++k)
            spent[k] = num(r, 1 + k);
        spentOffers.add(spent);
        ourPlayerData.setCurrentOffer(offer);
        negotiator.resetWantsAnotherOffer();
        for (int pn = 0; pn < game.maxPlayers; ++pn)
            offerRejections[pn] = false;
        waitingForTradeResponse = true;
        tradeResponseTimeoutSec = TRADE_RESPONSE_TIMEOUT_SEC_BOTS_ONLY;
        counter = 0;
        client.offerTrade(game, offer);
        return true;
    }

    /** trades mode: the stock brain asks when its plan lacks resources; our answer is an offer or "done". */
    @Override
    protected boolean makeOffer(SOCBuildPlan buildPlan)
    {
        if (oracle)
        {
            boolean made = super.makeOffer(buildPlan);
            SOCTradeOffer o = ourPlayerData.getCurrentOffer();
            oracle("makeOffer", made && o != null ? "{\"give\":" + set(o.getGiveSet()) + ",\"get\":" + set(o.getGetSet()) + "}" : "null");
            return made;
        }
        if (full)
        {
            doneTrading = true;
            waitingForTradeResponse = false;
            return false;
        }
        String[] r = ask("PLAY_TURN", null);
        if (r == null)
            return super.makeOffer(buildPlan);
        if (r[0].equals("OFFER_TRADE"))
            return sendOffer(r, -1);
        doneTrading = true;
        waitingForTradeResponse = false;
        return false;
    }

    // ---------------------------------------------------------------- full mode

    @Override
    protected void setStrategyFields()
    {
        super.setStrategyFields();
        if (oracle)
        {
            openingBuildStrategy = new OpeningBuildStrategy(game, ourPlayerData, this)
            {
                @Override
                public int planInitialSettlements()
                {
                    int n = super.planInitialSettlements();
                    oracle("planInitialSettlements", Integer.toString(n));
                    return n;
                }

                @Override
                public int planSecondSettlement()
                {
                    int n = super.planSecondSettlement();
                    oracle("planSecondSettlement", Integer.toString(n));
                    return n;
                }

                @Override
                public int planInitRoad()
                {
                    int e = super.planInitRoad();
                    int[] nodes = game.getBoard().getAdjacentNodesToEdge_arr(e);
                    oracle("planInitRoad", "[" + nodes[0] + "," + nodes[1] + "]");
                    return e;
                }
            };
            robberStrategy = new RobberStrategy(game, ourPlayerData, this, rand)
            {
                @Override
                public int getBestRobberHex()
                {
                    int h = super.getBestRobberHex();
                    oracle("getBestRobberHex", Integer.toString(h));
                    return h;
                }

                @Override
                public int chooseRobberVictim(final boolean[] isVictim, final boolean canChooseNone)
                {
                    int v = super.chooseRobberVictim(isVictim, canChooseNone);
                    oracle("chooseRobberVictim", Integer.toString(v));
                    return v;
                }
            };
            discardStrategy = new DiscardStrategy(game, ourPlayerData, this, rand)
            {
                @Override
                public SOCResourceSet discard(final int numDiscards, SOCBuildPlanStack buildingPlan)
                {
                    SOCResourceSet rs = super.discard(numDiscards, buildingPlan);
                    oracle("discard", set(rs));
                    return rs;
                }
            };
            monopolyStrategy = new MonopolyStrategy(game, ourPlayerData, this)
            {
                @Override
                public int getMonopolyChoice()
                {
                    int r = super.getMonopolyChoice();
                    oracle("getMonopolyChoice", Integer.toString(r));
                    return r;
                }
            };
            return;
        }
        if (! full)
            return;
        openingBuildStrategy = new OpeningBuildStrategy(game, ourPlayerData, this)
        {
            @Override
            public int planInitialSettlements()
            {
                String[] r = ask("BUILD_INITIAL_SETTLEMENT", null);
                return r == null ? super.planInitialSettlements() : num(r, 1);
            }

            @Override
            public int planSecondSettlement()
            {
                String[] r = ask("BUILD_INITIAL_SETTLEMENT", null);
                return r == null ? super.planSecondSettlement() : num(r, 1);
            }

            @Override
            public int planInitRoad()
            {
                String[] r = ask("BUILD_INITIAL_ROAD", null);
                return r == null ? super.planInitRoad() : game.getBoard().getEdgeBetweenAdjacentNodes(num(r, 1), num(r, 2));
            }
        };
        robberStrategy = new RobberStrategy(game, ourPlayerData, this, rand)
        {
            @Override
            public int getBestRobberHex()
            {
                String[] r = ask("MOVE_ROBBER", null);
                if (r == null)
                    return super.getBestRobberHex();
                pendingVictim = num(r, 2);
                return num(r, 1);
            }

            @Override
            public int chooseRobberVictim(final boolean[] isVictim, final boolean canChooseNone)
            {
                if ((pendingVictim >= 0) && (pendingVictim < isVictim.length) && isVictim[pendingVictim])
                    return pendingVictim;
                return super.chooseRobberVictim(isVictim, canChooseNone);
            }
        };
        discardStrategy = new DiscardStrategy(game, ourPlayerData, this, rand)
        {
            @Override
            public SOCResourceSet discard(final int numDiscards, SOCBuildPlanStack buildingPlan)
            {
                String[] r = ask("DISCARD", "\"discard\":" + numDiscards);
                return r == null ? super.discard(numDiscards, buildingPlan) : set5(r, 1);
            }
        };
        monopolyStrategy = new MonopolyStrategy(game, ourPlayerData, this)
        {
            @Override
            public int getMonopolyChoice()
            {
                return pendingMono;
            }

            @Override
            public boolean decidePlayMonopoly()
            {
                return false; // played from planStuff when the decision server says so
            }
        };
    }

    @Override
    protected SOCRobotDM createDM()
    {
        if (! full)
            return super.createDM();
        return new SOCRobotDM(this)
        {
            @Override
            public boolean shouldPlayKnightForLA()
            {
                if (game.getGameState() != SOCGame.PLAY1)
                    return super.shouldPlayKnightForLA();
                cachedPlay1 = ask("PLAY_TURN", null);
                if (cachedPlay1 == null)
                    return super.shouldPlayKnightForLA();
                boolean knight = cachedPlay1[0].equals("PLAY_KNIGHT_CARD");
                if (knight)
                {
                    cachedPlay1 = null;
                    movingKnight = true;
                }
                return knight;
            }

            @Override
            public void planStuff(final int strategy)
            {
                String[] r = cachedPlay1 != null ? cachedPlay1 : ask("PLAY_TURN", null);
                cachedPlay1 = null;
                if (r == null)
                {
                    super.planStuff(strategy);
                    return;
                }
                act(r);
            }

            @Override
            protected SOCResourceSet pickFreeResources(int numChoose)
            {
                return resourceChoices != null ? resourceChoices : super.pickFreeResources(numChoose);
            }
        };
    }

    /** The main-phase action: builds become the plan, everything else is sent now. */
    private void act(String[] r)
    {
        SOCBoard b = game.getBoard();
        buildingPlan.clear();
        switch (r[0])
        {
        case "BUILD_ROAD":
            buildingPlan.push(new SOCPossibleRoad(ourPlayerData, b.getEdgeBetweenAdjacentNodes(num(r, 1), num(r, 2)), null));
            break;
        case "BUILD_SETTLEMENT":
            buildingPlan.push(new SOCPossibleSettlement(ourPlayerData, num(r, 1), null, getEstimatorFactory()));
            break;
        case "BUILD_CITY":
            buildingPlan.push(new SOCPossibleCity(ourPlayerData, num(r, 1), getEstimatorFactory()));
            break;
        case "BUY_DEVELOPMENT_CARD":
            buildingPlan.push(new SOCPossibleCard(ourPlayerData, 1));
            break;
        case "PLAY_ROAD_BUILDING":
            // two roads first in the plan: SOCRobotBrain.buildOrGetResourceByTradeOrCard plays the card for them
            for (int i = 3; i >= 1; i -= 2)
                if (num(r, i) >= 0)
                    buildingPlan.push(new SOCPossibleRoad(ourPlayerData, b.getEdgeBetweenAdjacentNodes(num(r, i), num(r, i + 1)), null));
            break;
        case "PLAY_KNIGHT_CARD":
            movingKnight = true;
            expectPLACING_ROBBER = true;
            waitingForGameState = true;
            counter = 0;
            client.playDevCard(game, SOCDevCardConstants.KNIGHT);
            pause(1500);
            break;
        case "PLAY_YEAR_OF_PLENTY":
            {
                int[] counts = new int[7];
                counts[num(r, 1)]++;
                if (num(r, 2) > 0)
                    counts[num(r, 2)]++;
                decisionMaker.getResourceChoices().clear();
                for (int t = SOCResourceConstants.CLAY; t <= SOCResourceConstants.WOOD; ++t)
                    decisionMaker.getResourceChoices().add(counts[t], t);
                expectWAITING_FOR_DISCOVERY = true;
                waitingForGameState = true;
                counter = 0;
                client.playDevCard(game, SOCDevCardConstants.DISC);
                pause(1500);
            }
            break;
        case "PLAY_MONOPOLY":
            pendingMono = num(r, 1);
            expectWAITING_FOR_MONOPOLY = true;
            waitingForGameState = true;
            counter = 0;
            client.playDevCard(game, SOCDevCardConstants.MONO);
            pause(1500);
            break;
        case "MARITIME_TRADE":
            {
                SOCResourceSet give = new SOCResourceSet(), get = new SOCResourceSet();
                give.add(num(r, 2), num(r, 1));
                get.add(1, num(r, 3));
                waitingForTradeMsg = true;
                counter = 0;
                client.bankTrade(game, give, get);
                pause(1500);
            }
            break;
        case "OFFER_TRADE":
            sendOffer(r, -1);
            break;
        default: // END_TURN, ROLL: no plan, the brain's loop ends the turn
            break;
        }
    }

    /** Before the roll: a knight if the decision server says so, else the dice. */
    @Override
    protected void rollOrPlayKnightOrExpectDice()
    {
        if (! full)
        {
            super.rollOrPlayKnightOrExpectDice();
            return;
        }
        expectROLL_OR_CARD = false;
        if ((! waitingForOurTurn) && ourTurn)
        {
            if (! expectPLAY1 && ! expectDISCARD && ! expectPLACING_ROBBER && ! (expectDICERESULT && (counter < 4000)))
            {
                String[] r = game.canPlayKnight(ourPlayerNumber) ? ask("ROLL", null) : null;
                if ((r != null) && r[0].equals("PLAY_KNIGHT_CARD"))
                {
                    movingKnight = true;
                    expectPLACING_ROBBER = true;
                    waitingForGameState = true;
                    counter = 0;
                    client.playDevCard(game, SOCDevCardConstants.KNIGHT);
                    pause(1500);
                }
                else
                {
                    expectDICERESULT = true;
                    counter = 0;
                    client.rollDice(game);
                }
            }
        }
        else
        {
            expectDICERESULT = true;
        }
    }

    /** The server refused a piece we asked for: dump the decision so the mismatch can be reproduced offline. */
    @Override
    protected void cancelWrongPiecePlacement(soc.message.SOCCancelBuildRequest mes)
    {
        System.err.println("bridge " + ourPlayerName + " REJECTED piece type " + mes.getPieceType() + " after " + lastReply + " for " + lastRequest + " board " + lastBoard);
        super.cancelWrongPiecePlacement(mes);
    }

    @Override
    protected void robberMoved(final int newHex)
    {
        super.robberMoved(newHex);
        pendingVictim = -1;
    }

    @Override
    protected void resetFieldsAtEndTurn()
    {
        super.resetFieldsAtEndTurn();
        movingKnight = false;
        cachedPlay1 = null;
        spentOffers.clear();
    }

}

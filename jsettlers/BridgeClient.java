/*
 * Catan RL bridge bot for JSettlers (docs/BENCHMARK.md Phase B).
 * Copyright (C) 2026 the settlers_of_catan_rl authors.
 *
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 3 of the
 * License, or (at your option) any later version. It links against JSettlers2 (GPL-3).
 */
package catanrl;

import java.io.FileWriter;
import java.io.IOException;

import soc.baseclient.ServerConnectInfo;
import soc.game.SOCGame;
import soc.game.SOCPlayer;
import soc.message.SOCGameState;
import soc.message.SOCMessage;
import soc.robot.SOCRobotBrain;
import soc.robot.SOCRobotClient;
import soc.util.CappedQueue;
import soc.util.SOCFeatureSet;
import soc.util.SOCRobotParameters;

/**
 * A third-party robot client whose brain is {@link BridgeBrain}: JSettlers keeps the protocol and the
 * game tracking, our decision server (jsettlers_server.py) makes the decisions. Configured by system
 * properties so it can run inside the server JVM ({@code -Djsettlers.bots.start3p=1,catanrl.BridgeClient})
 * or standalone ({@code java catanrl.BridgeClient host port nick pw cookie}):
 * <ul>
 * <li>{@code bridge.mode}: {@code full} (every decision is ours) or {@code trades} (only offers and
 *     replies; the stock SOCRobotBrain plays the rest, the paper's DRRL setup)</li>
 * <li>{@code bridge.player}: a value_net.make_player token, e.g. {@code vnet:checkpoints_value/v40.pt},
 *     {@code drrl}, {@code ab}</li>
 * <li>{@code bridge.repo}: the repository root (where {@code uv run python jsettlers_server.py} works)</li>
 * <li>{@code bridge.results}: a file that gets one line per finished game</li>
 * </ul>
 */
public class BridgeClient extends SOCRobotClient
{
    public static final String MODE = System.getProperty("bridge.mode", "full");
    public static final String PLAYER = System.getProperty("bridge.player", "vnet:checkpoints_value/v40.pt");
    public static final String REPO = System.getProperty("bridge.repo", ".");
    public static final String RESULTS = System.getProperty("bridge.results", "");

    /** One decision server per client, shared by its brains: a `drrl+` player keeps its weights across games. */
    BridgeBrain.Decider decider;

    public BridgeClient(final ServerConnectInfo sci, final String nn, final String pw)
    {
        super(sci, nn, pw);
        rbclass = BridgeClient.class.getName();
    }

    synchronized BridgeBrain.Decider decider() throws IOException
    {
        if (decider == null)
            decider = new BridgeBrain.Decider();
        return decider;
    }

    /**
     * The result line, written when the game-over state arrives: the stats message that follows is queued
     * to the brain, which this method's superclass kills first, so under load it is never seen. Scores are
     * the client's totals (exact for us; opponents' hidden VP cards may be missing), the winner is the
     * player whose turn it is. Format: {@code game ourPn winnerPn score0..3 name0..3}.
     */
    @Override
    protected void handleGAMESTATE(SOCGameState mes)
    {
        SOCGame ga = games.get(mes.getGame());
        if ((ga != null) && (mes.getState() == SOCGame.OVER) && ! RESULTS.isEmpty())
        {
            SOCPlayer us = ga.getPlayer(nickname);
            if (us != null)
            {
                StringBuilder sb = new StringBuilder(ga.getName()).append(' ').append(us.getPlayerNumber()).append(' ').append(ga.getCurrentPlayerNumber());
                for (int pn = 0; pn < ga.maxPlayers; ++pn)
                    sb.append(' ').append(ga.isSeatVacant(pn) ? 0 : ga.getPlayer(pn).getTotalVP());
                for (int pn = 0; pn < ga.maxPlayers; ++pn)
                    sb.append(' ').append(ga.isSeatVacant(pn) ? "-" : ga.getPlayer(pn).getName().replace(' ', '_'));
                System.err.println("bridge result: " + sb);
                try (FileWriter w = new FileWriter(RESULTS, true))
                {
                    w.write(sb.append('\n').toString());
                }
                catch (IOException e)
                {
                    System.err.println("bridge: cannot write results: " + e);
                }
                if (decider != null)
                {
                    try
                    {
                        decider.ask("{\"op\":\"end\"}");
                    }
                    catch (IOException e)
                    {
                        System.err.println("bridge: " + e);
                    }
                }
            }
        }
        super.handleGAMESTATE(mes);
    }

    /** Classic board only: no 6-player, no sea board, no scenarios. */
    @Override
    protected SOCFeatureSet buildClientFeats()
    {
        return new SOCFeatureSet(false, false);
    }

    @Override
    public SOCRobotBrain createBrain(final SOCRobotParameters params, final SOCGame ga, final CappedQueue<SOCMessage> mq)
    {
        return new BridgeBrain(this, params, ga, mq);
    }

    public static void main(String[] args)
    {
        if (args.length < 5)
        {
            System.err.println("usage: java catanrl.BridgeClient host port nickname password cookie   (-Dbridge.mode=full|trades -Dbridge.player=<token> -Dbridge.repo=<dir> -Dbridge.results=<file>)");
            return;
        }
        BridgeClient cli = new BridgeClient(new ServerConnectInfo(args[0], Integer.parseInt(args[1]), args[4]), args[2], args[3]);
        cli.init();
    }
}

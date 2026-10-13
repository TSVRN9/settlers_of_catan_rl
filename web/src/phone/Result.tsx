// The end of a game (spec "Game over"; review.mjs C and D): the bottom block gives way to the result — who won, your
// place, the whole game's curve with your line bold, the final points with the VP cards face up — and Rematch, which
// keeps the lineup and the board. It covers the block, which keeps its height, so the board does not move. A watched
// or shared game's result names the round and each seat's occupant, and Watch plays it again from the start.
import { useEffect, useState } from "react";
import Card from "../board/Card";
import { SEAT_FILL } from "../board/palette";
import { rewatch, shareLink, start, toLineup } from "../game";
import { BOT_SHORT, placeText, roundOf, who } from "../labels";
import { playing, useApp, you } from "../store";
import Curve, { seatInk } from "./Curve";
import { places } from "./standings";
import { seen, useMetrics } from "./usePhone";


export default function Result() {
  const s = useApp();
  const { btnH } = useMetrics();
  const [copied, setCopied] = useState(false);
  const v = s.view!;
  const watched = !playing(s);
  const people = s.lineup.filter((b) => b.kind === "human").length;
  // Two people at one phone: whoever held it last is not "you" to the other, so the result names every seat.
  const me = people > 1 ? -1 : you(s);
  const vps = v.players.map((p) => p.actual_vp ?? p.vp);
  const pl = places(vps, v.winner);
  const order = vps.map((_, i) => i).sort((a, b) => pl[a] - pl[b] || a - b);
  const tied = me >= 0 && pl.some((p, j) => j !== me && p === pl[me]);
  const frames = seen(s);
  const last = frames.length - 1;
  const kind = (i: number) => (s.film === "unnamed" ? "" : s.lineup[i]?.kind === "human" ? "Person" : BOT_SHORT[s.lineup[i]?.kind ?? ""] ?? "");
  // The link is made as the result arrives, not on the tap: a share sheet or the clipboard only answers inside the tap
  // itself, and making the link is a round trip to a worker.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    shareLink().then((u) => { if (on) setUrl(u); }, (e) => console.warn("no link for this game:", e));
    return () => { on = false; };
  }, [s.frames.length, s.seed]);
  // The link goes in the address bar too, so a reload reopens this game; then the share sheet, or the clipboard.
  const onShare = () => {
    if (!url) return;
    history.replaceState(history.state, "", url);
    if (navigator.share) { navigator.share({ url }).catch(() => { /* dismissed */ }); return; }
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => { /* the address bar has it */ });
  };
  return (
    <div className={`ph-result cover arrive${watched ? " watched" : ""}`}>
      <div className="hd">
        <span className="d win" style={{ color: seatInk(v.winner) }}>{who(v.winner, me)} won</span>
        {watched ? <span className="num rd">{roundOf(frames, v)}</span>
          : people === 1 && me !== v.winner && <span className="pl">{placeText(pl[me], tied)}</span>}
      </div>
      <Curve className="curve" frames={frames} at={last} upto={last} bold={me >= 0 ? me : v.winner} />
      <div className="rows">
        {order.map((i) => (
          <div key={i} className="row">
            <i className="sw" style={{ background: SEAT_FILL[i] }} />
            <span className="nm">{who(i, me)}</span>
            {watched && <span className="kd">{kind(i)}</span>}
            <span className="vpc">{Array.from({ length: v.players[i].devs[4] }, (_, k) => <Card key={k} dev={4} width={22} height={30} />)}</span>
            <span className="d num vp" style={i === v.winner ? { color: seatInk(i) } : undefined}>{vps[i]}</span>
          </div>
        ))}
      </div>
      <div className="ph-row" style={{ height: btnH }}>
        <button className="ph-btn cut8" onClick={toLineup}>Lineup</button>
        <button className="ph-btn ph-share cut8" disabled={!url} onClick={onShare}>{copied ? "Copied" : "Share"}</button>
        {watched
          ? <button className="ph-btn go ph-rewatch cut8" onClick={rewatch}>Watch</button>
          : <button className="ph-btn go ph-rematch cut8" onClick={() => void start()}>Rematch</button>}
      </div>
    </div>
  );
}

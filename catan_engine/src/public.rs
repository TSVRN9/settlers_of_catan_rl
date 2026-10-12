//! Win chances from public information (docs/FINDINGS.md 2026-10-12). The net reads a position from one seat's
//! perspective, so `reading(seat)` uses that seat's hand, dev cards and actual_vp: shown to anyone else, its bar jumps
//! when it draws a VP card. `public_evals` keeps the viewer's own reading (it already sees only the others' public
//! features) and averages every other seat's over deals of the cards the viewer cannot see.

use crate::encode::Layout;
use crate::jsettler::view::Views;
use crate::state::{State, VICTORY_POINT};
use crate::valuenet::{sigmoid, ValueNet, N_HEADS};

/// The 25-card deck by card (KNIGHT, YEAR_OF_PLENTY, MONOPOLY, ROAD_BUILDING, VICTORY_POINT), as `State::new` builds it.
pub const DEV_DECK: [i32; 5] = [14, 2, 2, 2, 5];

/// One seat's forecast: (P(win), the VP heads from its own perspective, turns left) — `Engine::evaluate`'s fields.
pub type Reading = (f64, Vec<f64>, f64);

/// What `viewer` (None = a spectator) knows of the hidden cards.
pub struct Hidden {
    pub viewer: Option<usize>,
    /// Per seat, the resource cards whose type the viewer knows (the viewer's own hand: all of it).
    pub known: Vec<[i32; 5]>,
    /// Per seat, how many it holds of unknown type.
    pub unknown: Vec<i32>,
    /// The unseen resource cards, one entry per card: exactly the non-viewers' unknown cards.
    pub res_pool: Vec<u8>,
    /// The unseen dev cards: the non-viewers' hands and the deck.
    pub dev_pool: Vec<u8>,
    /// The client view's arithmetic added up; false = fell back to hand sizes only (never seen, see FINDINGS).
    pub consistent: bool,
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn shuffle(v: &mut [u8], rng: &mut u64) {
    for i in (1..v.len()).rev() {
        v.swap(i, (splitmix(rng) % (i as u64 + 1)) as usize);
    }
}

fn cards(counts: &[i32; 5]) -> Vec<u8> {
    (0..5u8).flat_map(|t| std::iter::repeat(t).take(counts[t as usize].max(0) as usize)).collect()
}

impl State {
    /// `viewer`'s knowledge, from public data and its own cards only: the JSettlers client's view of every hand
    /// replayed from the events (jsettler/view.rs: steals typed only for the two parties, discards hidden), the bank,
    /// hand and dev-card counts, played dev cards. Never the other seats' card types, actual_vp or the deck order.
    /// Needs a live state: a `clone_light` copy has no events.
    pub fn hidden(&self, viewer: Option<usize>) -> Hidden {
        assert!(!self.light, "a clone_light state has no event history");
        let n = self.n;
        let mut views = Views::new(n);
        for e in &self.events {
            views.apply(e, viewer.unwrap_or(n));
        }
        let mut known = vec![[0; 5]; n];
        let mut unknown = vec![0; n];
        let mut pool = self.bank.map(|b| 19 - b); // every card in some hand
        let mut consistent = true;
        for s in 0..n {
            let (k, u) = if Some(s) == viewer { (self.players[s].hand, 0) } else { (views.known(s), views.0[s][5]) };
            consistent &= u >= 0 && k.iter().all(|&x| x >= 0) && k.iter().sum::<i32>() + u == self.num_resources(s);
            known[s] = k;
            unknown[s] = u;
            for r in 0..5 {
                pool[r] -= k[r];
            }
        }
        consistent &= pool.iter().all(|&x| x >= 0) && pool.iter().sum::<i32>() == unknown.iter().sum::<i32>();
        if !consistent {
            // forget the types, keep the sizes: bank + hands = 19 of each, so this always adds up
            pool = self.bank.map(|b| 19 - b);
            for s in (0..n).filter(|&s| Some(s) != viewer) {
                known[s] = [0; 5];
                unknown[s] = self.num_resources(s);
            }
            if let Some(v) = viewer {
                (0..5).for_each(|r| pool[r] -= self.players[v].hand[r]);
            }
        }
        let mut devs = DEV_DECK;
        for (s, p) in self.players.iter().enumerate() {
            for c in 0..5 {
                devs[c] -= p.played[c] + if Some(s) == viewer { p.devs[c] } else { 0 };
            }
        }
        Hidden { viewer, known, unknown, res_pool: cards(&pool), dev_pool: cards(&devs), consistent }
    }

    /// A copy with every non-viewer's hidden cards redealt uniformly from `h`'s pools (`rng` advanced). Known cards,
    /// hand and dev-card counts and the viewer's own cards stay; actual_vp = vp + dealt VP cards; the deck is what is
    /// left. A deal that puts a seat at the winning score is redrawn: it would already have won on its own turn.
    /// `owned_at_start` is not redealt (the encoder doesn't read it).
    pub fn deal(&self, h: &Hidden, rng: &mut u64) -> State {
        let mut st = self.clone_light();
        let others: Vec<usize> = (0..self.n).filter(|&s| Some(s) != h.viewer).collect();
        let mut res = h.res_pool.clone();
        shuffle(&mut res, rng);
        let mut i = 0;
        for &s in &others {
            let mut hand = h.known[s];
            for &r in &res[i..i + h.unknown[s] as usize] {
                hand[r as usize] += 1;
            }
            i += h.unknown[s] as usize;
            st.players[s].hand = hand;
        }
        debug_assert_eq!(i, res.len());
        let mut dev = h.dev_pool.clone();
        for attempt in 0..64 {
            shuffle(&mut dev, rng);
            let mut i = 0;
            let mut ok = true;
            for &s in &others {
                let k = self.players[s].devs.iter().sum::<i32>() as usize;
                let mut d = [0; 5];
                dev[i..i + k].iter().for_each(|&c| d[c as usize] += 1);
                i += k;
                let p = &mut st.players[s];
                p.devs = d;
                p.actual_vp = p.vp + d[VICTORY_POINT];
                ok &= p.actual_vp < self.vps_to_win;
            }
            // ponytail: rejection; after 64 misses the last deal stands (no such position has been seen)
            if ok || attempt == 63 {
                st.dev_deck = dev[i..].iter().copied().collect();
                break;
            }
        }
        st
    }

    /// The net's forecast for `seat` from its own perspective (`Engine::evaluate`); exact on a finished game.
    pub fn reading(&self, net: &ValueNet, layout: &Layout, seat: usize) -> Reading {
        if self.winner() >= 0 {
            let vps = (0..self.n).map(|i| self.players[(seat + i) % self.n].actual_vp as f64).collect();
            return ((self.winner() as usize == seat) as u8 as f64, vps, 0.0);
        }
        let h = net.heads(&self.encoded(seat, layout));
        (sigmoid(h[0] as f64), (1..5).map(|i| h[i] as f64 * 10.0).collect(), h[5] as f64 * 100.0)
    }

    /// Every seat's reading as `viewer` (None = spectator) could know it: the viewer's own exactly, every other seat's
    /// averaged over `k` deals of the hidden cards (`deal`), each distinct (hand, devs) of that seat forwarded once.
    /// `seed` must come from public data (the site uses the game seed: the same position always reads the same, and
    /// consecutive positions share their random numbers, so a bar moves only when the public position does).
    /// Also returns `Hidden::consistent`.
    pub fn public_evals(&self, net: &ValueNet, layout: &Layout, viewer: Option<usize>, k: usize, seed: u64) -> (Vec<Reading>, bool) {
        if self.winner() >= 0 {
            return ((0..self.n).map(|s| self.reading(net, layout, s)).collect(), true);
        }
        let k = k.max(1); // never the full readings under the public name
        let h = self.hidden(viewer);
        let mut rng = seed;
        let deals: Vec<State> = (0..k).map(|_| self.deal(&h, &mut rng)).collect();
        let out = (0..self.n)
            .map(|s| {
                if Some(s) == viewer {
                    return self.reading(net, layout, s);
                }
                let mut uniq: Vec<(([i32; 5], [i32; 5]), usize, usize)> = Vec::new(); // (key, a deal with it, count)
                for (j, d) in deals.iter().enumerate() {
                    let key = (d.players[s].hand, d.players[s].devs);
                    match uniq.iter_mut().find(|u| u.0 == key) {
                        Some(u) => u.2 += 1,
                        None => uniq.push((key, j, 1)),
                    }
                }
                // the board half of the encoding is public; encode_rest_into overwrites every hand-dependent feature
                let base = self.encoded(s, layout);
                let mut xs = Vec::with_capacity(uniq.len() * base.len());
                for &(_, j, _) in &uniq {
                    let mut row = base.clone();
                    deals[j].encode_rest_into(s, layout, &mut row);
                    xs.extend_from_slice(&row);
                }
                let hs = net.forward_batch(&xs, uniq.len());
                let (mut win, mut vps, mut turns) = (0.0, vec![0.0; 4], 0.0);
                for (u, hd) in uniq.iter().zip(hs.chunks(N_HEADS)) {
                    let w = u.2 as f64 / k as f64;
                    win += w * sigmoid(hd[0] as f64);
                    (0..4).for_each(|i| vps[i] += w * hd[1 + i] as f64 * 10.0);
                    turns += w * hd[5] as f64 * 100.0;
                }
                (win, vps, turns)
            })
            .collect();
        (out, h.consistent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::Action;
    use crate::jsettler::brain::Jsettler;
    use crate::jsettler::dm::Params as JsParams;
    use crate::map::Map;
    use crate::state::KNIGHT;
    use crate::trade::Eval;
    use std::sync::Arc;

    fn layout() -> Layout {
        serde_json::from_str(include_str!("base_layout.json")).unwrap()
    }

    fn net(layout: &Layout) -> ValueNet {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/models/");
        let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}v89w.json")).unwrap()).unwrap();
        ValueNet::from_bytes(&std::fs::read(format!("{dir}v89w.bin")).unwrap(), layout.n_features, meta["hidden"].as_u64().unwrap() as usize, N_HEADS).unwrap()
    }

    /// A deal keeps everything the viewer knows and every card total; the same seed deals the same; a seat's hidden
    /// cards do not move any public reading (the leak this module closes).
    #[test]
    fn deals_are_consistent_and_hide_the_cards() {
        let layout = layout();
        let net = net(&layout);
        let mut s = State::new(Arc::new(Map::generate(7, &layout)), 4, 7, 10);
        let (mut steps, mut checked, mut swapped) = (0, 0, 0);
        while s.winner() < 0 && steps < 3000 {
            if steps % 20 == 0 {
                for viewer in [None, Some(0), Some(1), Some(2), Some(3)] {
                    let h = s.hidden(viewer);
                    assert!(h.consistent);
                    let mut rng = 99;
                    let d = s.deal(&h, &mut rng);
                    let mut rng2 = 99;
                    let d2 = s.deal(&h, &mut rng2);
                    let mut devs = [0; 5];
                    d.dev_deck.iter().for_each(|&c| devs[c as usize] += 1);
                    for r in 0..5 {
                        assert_eq!(d.bank[r] + d.players.iter().map(|p| p.hand[r]).sum::<i32>(), 19, "resource {r}");
                    }
                    for (q, (a, b)) in s.players.iter().zip(&d.players).enumerate() {
                        assert_eq!(a.hand.iter().sum::<i32>(), b.hand.iter().sum::<i32>());
                        assert_eq!(a.devs.iter().sum::<i32>(), b.devs.iter().sum::<i32>());
                        assert_eq!((a.vp, a.played), (b.vp, b.played));
                        assert_eq!(b.actual_vp, b.vp + b.devs[VICTORY_POINT]);
                        assert!(b.actual_vp < 10, "nobody is dealt a win they would already have taken");
                        if Some(q) == viewer {
                            assert_eq!((a.hand, a.devs, a.actual_vp), (b.hand, b.devs, b.actual_vp));
                        }
                        (0..5).for_each(|r| assert!(a.hand[r] >= h.known[q][r] && b.hand[r] >= h.known[q][r], "known cards are held and kept"));
                        (0..5).for_each(|c| devs[c] += b.devs[c] + b.played[c]);
                        assert_eq!((b.hand, b.devs), (d2.players[q].hand, d2.players[q].devs), "same seed, same deal");
                    }
                    assert_eq!(devs, DEV_DECK);
                    assert_eq!(d.dev_deck.len(), s.dev_deck.len());
                    checked += 1;
                    // the leak: trade a non-viewer's VP card for a knight; nothing public may change
                    let holder = (0..4).find(|&q| Some(q) != viewer && s.players[q].devs[VICTORY_POINT] > 0);
                    if let Some(q) = holder {
                        let mut t = s.clone();
                        let p = &mut t.players[q];
                        p.devs[VICTORY_POINT] -= 1;
                        p.devs[KNIGHT] += 1;
                        p.actual_vp -= 1;
                        let (a, b) = (s.public_evals(&net, &layout, viewer, 8, 5).0, t.public_evals(&net, &layout, viewer, 8, 5).0);
                        assert_eq!(a, b);
                        assert_ne!(s.reading(&net, &layout, q).0, t.reading(&net, &layout, q).0, "the full reading does see it");
                        swapped += 1;
                    }
                    if let Some(v) = viewer {
                        assert_eq!(s.public_evals(&net, &layout, viewer, 4, 1).0[v], s.reading(&net, &layout, v), "own seat is exact");
                    }
                }
            }
            let a = s.trade_action(&Eval::Heuristic).or_else(|| s.decide_heuristic(1)).unwrap_or(s.playable_actions()[0]);
            s.apply(a, None).unwrap();
            steps += 1;
        }
        assert!(checked > 100 && swapped > 0, "checked {checked}, swapped {swapped}");
    }

    // ---- measurement (docs/FINDINGS.md 2026-10-12) ----
    // cargo test --release --no-default-features --features wasm --lib public::tests::measure -- --ignored --nocapture
    // env: PUBLIC_GAMES (200), PUBLIC_K (the K under test, 4), PUBLIC_REF_EVERY (K=256 reference every n-th step, 1),
    // PUBLIC_THREADS (6)

    const KS: [usize; 4] = [4, 8, 16, 32];

    /// Per-game sums; every statistic is a ratio of totals, its CI a bootstrap over games.
    #[derive(Default, Clone)]
    struct G {
        v: std::collections::BTreeMap<String, f64>,
    }

    impl G {
        fn add(&mut self, k: &str, x: f64) {
            *self.v.entry(k.to_string()).or_default() += x;
        }
        fn get(&self, k: &str) -> f64 {
            self.v.get(k).copied().unwrap_or(0.0)
        }
    }

    fn env(k: &str, d: usize) -> usize {
        std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
    }

    fn play(g: usize, net: &ValueNet, layout: &Layout) -> Option<G> {
        let kk = env("PUBLIC_K", 4);
        let ref_every = env("PUBLIC_REF_EVERY", 1);
        let seed = 10_000 + g as u64;
        let mut s = State::new(Arc::new(Map::generate(seed, layout)), 4, seed.wrapping_mul(0x9E37_79B9_7F4A_7C15), 10);
        // lineups: two of the three bot kinds plus a third, rotated round the table
        let kinds = ["heuristic", "jsrobot", "jsdroid"];
        let bots: Vec<&str> = (0..4).map(|i| kinds[[0, 1, 2, g % 3][(i + g) % 4]]).collect();
        let mut js: Vec<Option<Jsettler>> = (0..4)
            .map(|i| (bots[i] != "heuristic").then(|| Jsettler::new(s.map.clone(), 4, i, if bots[i] == "jsdroid" { JsParams::FAST } else { JsParams::SMART }, seed ^ i as u64, crate::jsettler::geom::NODE_JS_ROT0)))
            .collect();
        let mut st = G::default();
        let mut rows: Vec<([f64; 4], [f64; 4], [f64; 4], Option<[f64; 4]>)> = vec![]; // full, spectator(K), viewer 0 (K), spectator(256)
        let mut prev: Option<([f64; 4], [f64; 4], [f64; 4])> = None;
        let mut buy: Option<(usize, bool)> = None;
        let mut steps = 0;
        let wins = |r: &[Reading]| -> [f64; 4] { std::array::from_fn(|i| r[i].0) };
        while s.winner() < 0 && steps < 6000 {
            let full: [f64; 4] = std::array::from_fn(|q| s.reading(net, layout, q).0);
            let t0 = std::time::Instant::now();
            let (spec, ok) = s.public_evals(net, layout, None, kk, seed);
            st.add("ms_spec", t0.elapsed().as_secs_f64() * 1e3);
            let (view, ok0) = s.public_evals(net, layout, Some(0), kk, seed);
            let (spec, view) = (wins(&spec), wins(&view));
            st.add("calls", 2.0);
            st.add("inconsistent", (!ok) as u8 as f64 + (!ok0) as u8 as f64);
            for viewer in [None, Some(0usize)] {
                let h = s.hidden(viewer);
                for q in 0..4 {
                    st.add("known_over_truth", (0..5).filter(|&r| h.known[q][r] > s.players[q].hand[r]).count() as f64);
                }
            }
            let mut refp = None;
            if steps % ref_every == 0 {
                let r = wins(&s.public_evals(net, layout, None, 256, seed ^ 0xABCD_EF01).0);
                st.add("ref_n", 4.0);
                for (i, &k) in KS.iter().enumerate() {
                    let p = if k == kk { spec } else { wins(&s.public_evals(net, layout, None, k, seed).0) };
                    let e: f64 = (0..4).map(|q| (p[q] - r[q]).abs()).sum();
                    st.add(["kerr4", "kerr8", "kerr16", "kerr32"][i], e);
                    st.add(["kmax4", "kmax8", "kmax16", "kmax32"][i], (0..4).filter(|&q| (p[q] - r[q]).abs() > 0.02).count() as f64);
                }
                refp = Some(r);
            }
            if let (Some((b, vp)), Some(p)) = (buy.take(), prev) {
                let tag = if vp { "vp" } else { "non" };
                let mut put = |mode: &str, d: f64| {
                    st.add(&format!("leak_{mode}_{tag}"), d);
                    st.add(&format!("leak_{mode}_{tag}_n"), 1.0);
                };
                put("full", full[b] - p.0[b]);
                put("spec", spec[b] - p.1[b]);
                if b != 0 {
                    put("fullv", full[b] - p.0[b]);
                    put("view", view[b] - p.2[b]);
                }
            }
            prev = Some((full, spec, view));
            rows.push((full, spec, view, refp));
            let q = s.current_player;
            let a = match js[q].as_mut() {
                Some(j) => j.decide(&s),
                None => s.trade_action(&Eval::Heuristic).or_else(|| s.decide_heuristic(1)),
            }
            .unwrap_or(s.playable_actions()[0]);
            let o = s.apply(a, None).unwrap();
            if a == Action::BuyDev && s.winner() < 0 {
                buy = Some((q, o.0 == VICTORY_POINT as i32));
                // the counterfactual: the same position with the other kind of card drawn
                let mut t = s.clone();
                let p = &mut t.players[q];
                let (out, inn) = if o.0 == VICTORY_POINT as i32 { (VICTORY_POINT, KNIGHT) } else { (o.0 as usize, VICTORY_POINT) };
                p.devs[out] -= 1;
                p.devs[inn] += 1;
                p.actual_vp = p.vp + p.devs[VICTORY_POINT];
                if t.winner() < 0 {
                    st.add("cf_n", 1.0);
                    st.add("cf_full", (s.reading(net, layout, q).0 - t.reading(net, layout, q).0).abs());
                    st.add("cf_spec", (s.public_evals(net, layout, None, kk, seed).0[q].0 - t.public_evals(net, layout, None, kk, seed).0[q].0).abs());
                    if q != 0 {
                        st.add("cf_view", (s.public_evals(net, layout, Some(0), kk, seed).0[q].0 - t.public_evals(net, layout, Some(0), kk, seed).0[q].0).abs());
                    }
                }
            }
            steps += 1;
        }
        let w = s.winner();
        if w < 0 {
            return None;
        }
        st.add("games", 1.0);
        st.add("steps", steps as f64);
        for (full, spec, view, refp) in rows {
            for q in 0..4 {
                let y = (q as i8 == w) as u8 as f64;
                let ll = |p: f64| -(if y > 0.5 { p } else { 1.0 - p }).clamp(1e-6, 1.0).ln();
                st.add("n_all", 1.0);
                st.add("brier_full", (full[q] - y).powi(2));
                st.add("brier_spec", (spec[q] - y).powi(2));
                st.add("ll_full", ll(full[q]));
                st.add("ll_spec", ll(spec[q]));
                if let Some(r) = refp {
                    st.add("n_ref", 1.0);
                    st.add("brier_ref", (r[q] - y).powi(2));
                    st.add("brier_full_at_ref", (full[q] - y).powi(2));
                }
                if q != 0 {
                    st.add("n_v", 1.0);
                    st.add("brier_fullv", (full[q] - y).powi(2));
                    st.add("brier_view", (view[q] - y).powi(2));
                    st.add("ll_fullv", ll(full[q]));
                    st.add("ll_view", ll(view[q]));
                }
            }
        }
        Some(st)
    }

    /// Bootstrap over games: (point, lo, hi) of `f` on the summed totals.
    fn boot(gs: &[G], f: impl Fn(&G) -> f64) -> (f64, f64, f64) {
        let sum = |pick: &mut dyn FnMut() -> usize| {
            let mut t = G::default();
            for _ in 0..gs.len() {
                for (k, v) in &gs[pick()].v {
                    t.add(k, *v);
                }
            }
            f(&t)
        };
        let mut i = 0;
        let point = sum(&mut || {
            i += 1;
            i - 1
        });
        let mut rng = 12345u64;
        let mut bs: Vec<f64> = (0..1000).map(|_| sum(&mut || (splitmix(&mut rng) % gs.len() as u64) as usize)).collect();
        bs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (point, bs[25], bs[974])
    }

    #[test]
    #[ignore]
    fn measure() {
        let layout = layout();
        let net = net(&layout);
        let games = env("PUBLIC_GAMES", 200);
        let next = std::sync::atomic::AtomicUsize::new(0);
        let out = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|sc| {
            for _ in 0..env("PUBLIC_THREADS", 6) {
                sc.spawn(|| loop {
                    let g = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if g >= games {
                        break;
                    }
                    let r = play(g, &net, &layout);
                    eprintln!("game {g} done: {}", r.is_some());
                    out.lock().unwrap().extend(r);
                });
            }
        });
        let gs = out.into_inner().unwrap();
        let p = |name: &str, (a, lo, hi): (f64, f64, f64)| println!("{name:<44} {a:>10.5}  [{lo:.5}, {hi:.5}]");
        let t = |k: &str| boot(&gs, |g| g.get(k)).0;
        println!("games {} (finished), steps {}, K = {}", t("games"), t("steps"), env("PUBLIC_K", 4));
        println!("inconsistent pools {} of {} calls; known > truth {}", t("inconsistent"), t("calls"), t("known_over_truth"));
        p("native ms per spectator public_evals", boot(&gs, |g| g.get("ms_spec") / g.get("steps")));
        for k in ["4", "8", "16", "32"] {
            let (e, m) = (format!("kerr{k}"), format!("kmax{k}"));
            p(&format!("K={k}: mean |p - p256|"), boot(&gs, |g| g.get(&e) / g.get("ref_n")));
            p(&format!("K={k}: share |p - p256| > 2 pp"), boot(&gs, |g| g.get(&m) / g.get("ref_n")));
        }
        for (a, b, n) in [("brier_full_at_ref", "brier_ref", "n_ref"), ("brier_full", "brier_spec", "n_all"), ("ll_full", "ll_spec", "n_all"), ("brier_fullv", "brier_view", "n_v"), ("ll_fullv", "ll_view", "n_v")] {
            p(a, boot(&gs, |g| g.get(a) / g.get(n)));
            p(b, boot(&gs, |g| g.get(b) / g.get(n)));
            p(&format!("{b} - {a}"), boot(&gs, |g| (g.get(b) - g.get(a)) / g.get(n)));
        }
        println!("counterfactual buys (drawn card swapped VP <-> other): {}", t("cf_n"));
        for m in ["cf_full", "cf_spec", "cf_view"] {
            p(&format!("{m}: mean |dP|"), boot(&gs, |g| g.get(m) / g.get("cf_n")));
        }
        for m in ["full", "spec", "fullv", "view"] {
            let (vp, vn, non, nn) = (format!("leak_{m}_vp"), format!("leak_{m}_vp_n"), format!("leak_{m}_non"), format!("leak_{m}_non_n"));
            println!("{m}: buys {} VP, {} other", t(&vn), t(&nn));
            p(&format!("{m}: mean dP after a VP card"), boot(&gs, |g| g.get(&vp) / g.get(&vn)));
            p(&format!("{m}: mean dP after another card"), boot(&gs, |g| g.get(&non) / g.get(&nn)));
            p(&format!("{m}: gap"), boot(&gs, |g| g.get(&vp) / g.get(&vn) - g.get(&non) / g.get(&nn)));
        }
    }
}

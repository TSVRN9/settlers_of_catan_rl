//! The sandbox (the site's `#/sandbox`): a game at a real table, entered as it happens and replayed through the rules.
//! An entry is an action and its outcome, or no outcome where the person entering it can't see one: a steal between
//! two other seats, another seat's development card. Those are typed here, at replay, as whatever keeps the whole log
//! legal; a later build, discard, card play or monopoly by that seat is what pins them down. The win readings never
//! see the types picked: `public_evals` reads the other seats from the events, where a steal is typed for its two
//! parties only and a bought card not at all.

use crate::actions::Action;
use crate::apply::Outcome;
use crate::state::*;

/// An action, its outcome (`None`: not seen), and for a monopoly what each seat handed over (seen at the table, and
/// the one event that says exactly how many of a kind a seat held).
#[derive(Clone, Copy, Debug)]
pub struct Entry {
    pub action: Action,
    pub outcome: Option<Outcome>,
    pub took: Option<[i32; 4]>,
}

#[derive(Debug, PartialEq)]
pub struct Fault {
    pub at: usize,
    pub message: String,
}

/// One card a seat is short of for an entry, or one card too many (a monopoly's count).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Need {
    Res(usize),
    Less(usize),
}

/// A placeholder for a card another seat bought and never played: anything but a victory point first, which would add
/// to its actual VP and could end the replayed game before the table's did.
const DEV_ORDER: [usize; 5] = [KNIGHT, YEAR_OF_PLENTY, MONOPOLY, ROAD_BUILDING, VICTORY_POINT];
/// Replays the search may spend before an entry is reported as wrong (a real typo costs this much once).
const RUNS: usize = 3000;
/// Fresh starts after the first search gets stuck.
const RESTARTS: u64 = 6;
/// How many retypes deep the search follows a chain of steals.
const DEPTH: usize = 3;
/// How many of the latest steals that could help a short seat a retype looks back over.
const REACH: usize = 8;

fn hidden(a: Action) -> bool {
    matches!(a, Action::BuyDev | Action::Roll) || matches!(a, Action::MoveRobber { victim, .. } if victim >= 0)
}

fn most_held(h: &[i32; 5], except: Option<usize>) -> Option<usize> {
    (0..5).filter(|&r| Some(r) != except && h[r] >= 1).max_by_key(|&r| (h[r], -(r as i32)))
}

fn default_outcome(s: &State, a: Action) -> Option<Outcome> {
    match a {
        Action::BuyDev => DEV_ORDER.iter().find(|&&c| s.dev_deck.contains(&(c as u8))).map(|&c| (c as i32, -1)),
        Action::MoveRobber { victim, .. } if victim >= 0 => most_held(&s.players[victim as usize].hand, None).map(|r| (r as i32, -1)),
        _ => None,
    }
}

fn outcome_ok(s: &State, a: Action, o: Outcome) -> bool {
    match a {
        Action::BuyDev => (0..5).contains(&o.0) && s.dev_deck.contains(&(o.0 as u8)),
        Action::MoveRobber { victim, .. } if victim >= 0 => (0..5).contains(&o.0) && s.players[victim as usize].hand[o.0 as usize] >= 1,
        Action::Roll => (1..=6).contains(&o.0) && (1..=6).contains(&o.1),
        _ => true,
    }
}

fn is_trade(a: Action) -> bool {
    matches!(a, Action::OfferTrade { .. } | Action::AcceptTrade | Action::RejectTrade | Action::ConfirmTrade { .. } | Action::CancelTrade)
}

/// `State::apply` trusts its caller (the arena only plays legal moves), so a build a seat can't afford would go through
/// with a negative hand; here every entry is checked first. Trades check themselves (an offer can be any bundle).
pub fn step(s: &mut State, a: Action, o: Option<Outcome>) -> Result<Outcome, String> {
    if !is_trade(a) && !s.search_actions().contains(&a) {
        return Err("not legal at this point".into());
    }
    s.apply(a, o)
}

/// `s` with the seat on move holding plenty of every card.
fn topped(s: &State) -> State {
    let mut t = s.clone();
    let p = t.current_player;
    for r in 0..5 {
        t.players[p].hand[r] += 10;
    }
    t
}

/// Where the seat on move could put a piece if it held the cards: the sandbox offers every spot the rules allow and
/// lets the replay type the hidden cards that paid for it.
pub fn placements(s: &State) -> Vec<Action> {
    topped(s)
        .search_actions()
        .into_iter()
        .filter(|a| matches!(a, Action::BuildRoad(_) | Action::BuildSettlement(_) | Action::BuildCity(_) | Action::MoveRobber { .. }))
        .collect()
}

fn monopoly_mismatch(s: &State, a: Action, took: Option<[i32; 4]>) -> Vec<(usize, Need)> {
    let (Action::PlayMonopoly(r), Some(k)) = (a, took) else { return vec![] };
    let r = r as usize;
    let mut out = vec![];
    for v in (0..s.n).filter(|&v| v != s.current_player) {
        let d = k[v] - s.players[v].hand[r];
        let need = if d > 0 { Need::Res(r) } else { Need::Less(r) };
        out.extend(std::iter::repeat((v, need)).take(d.unsigned_abs() as usize));
    }
    out
}

/// The cards a seat lacks for entry `a` at `s` (one unit each), or nothing when the entry would fail anyway.
fn needs(s: &State, e: &Entry, o: Option<Outcome>) -> Vec<(usize, Need)> {
    let p = s.current_player;
    let short = |seat: usize, cost: [i32; 5]| -> Vec<(usize, Need)> {
        (0..5).flat_map(|r| std::iter::repeat((seat, Need::Res(r))).take((cost[r] - s.players[seat].hand[r]).max(0) as usize)).collect()
    };
    let unit = |r: usize, k: i32| {
        let mut c = [0; 5];
        c[r] = k;
        c
    };
    let mono = monopoly_mismatch(s, e.action, e.took);
    if !mono.is_empty() {
        return mono;
    }
    let cost = match e.action {
        Action::BuildRoad(_) => ROAD_COST,
        Action::BuildSettlement(_) => SETTLEMENT_COST,
        Action::BuildCity(_) => CITY_COST,
        Action::BuyDev => DEV_COST,
        Action::Discard(r) => unit(r as usize, 1),
        Action::MaritimeTrade { give, rate, .. } => unit(give as usize, rate as i32),
        Action::OfferTrade { give, .. } => give.map(|g| g as i32),
        Action::AcceptTrade => std::array::from_fn(|r| s.current_trade[5 + r]),
        Action::MoveRobber { victim, .. } if victim >= 0 => {
            return match o {
                Some((r, _)) if (0..5).contains(&r) => short(victim as usize, unit(r as usize, 1)),
                _ => vec![],
            };
        }
        _ => return vec![],
    };
    // a steal moves a card, it never makes one: a hand too small for the cost is a mistake, not a mistyped steal
    let enough = s.num_resources(p) >= cost.iter().sum::<i32>();
    if enough && (is_trade(e.action) || topped(s).search_actions().contains(&e.action)) {
        short(p, cost)
    } else {
        vec![]
    }
}

/// The types hidden steal `a` (now `cur`, at state `s`) could take instead that move `seat` toward what it needs.
fn fixes(s: &State, a: Action, cur: i32, seat: usize, need: Need) -> Vec<i32> {
    let Action::MoveRobber { victim, .. } = a else { return vec![] };
    let (thief, v) = (s.current_player, victim as usize);
    let others = |r: usize| (0..5).filter(|&y| y != r && s.players[v].hand[y] >= 1).map(|y| y as i32).collect();
    match need {
        Need::Res(r) if seat == thief && cur != r as i32 => vec![r as i32], // it stole the card it later spends
        Need::Res(r) if seat == v && cur == r as i32 => others(r),          // the card it later spends wasn't taken
        Need::Less(r) if seat == thief && cur == r as i32 => others(r),
        Need::Less(r) if seat == v && cur != r as i32 => vec![r as i32],
        _ => vec![],
    }
}

struct Run {
    /// The state at the end, or just before the entry that failed.
    state: State,
    fault: Option<(usize, String)>,
}

/// One typing of the hidden steals and its replay. `snaps[i]` is the state before hidden steal `i`, where a retype
/// restarts; `pinned[i]` marks a type a retype chose, which fails the replay when the victim lacks it rather than
/// being replaced (so the next retype can see why).
#[derive(Clone)]
struct Try {
    /// 0: a steal with no type yet takes the victim's most-held card; else one drawn from its hand by this seed.
    salt: u64,
    val: Vec<Option<Outcome>>,
    pinned: Vec<bool>,
    snaps: Vec<Option<State>>,
    out: Vec<Outcome>,
}

/// A card drawn from `hand` the way a steal draws one, from seed `x`.
fn drawn(hand: &[i32; 5], mut x: u64) -> Option<Outcome> {
    let total: i32 = hand.iter().sum();
    if total <= 0 {
        return None;
    }
    x = x.wrapping_add(0x9E3779B97F4A7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D049BB133111EB);
    let mut k = ((x ^ (x >> 31)) % total as u64) as i32;
    (0..5).find(|&r| {
        k -= hand[r];
        k < 0
    })
    .map(|r| (r as i32, -1))
}

/// Replays `log[from..]` from `s`, typing each hidden steal that has no valid type yet as the victim's most-held card.
fn run(mut s: State, from: usize, log: &[Entry], t: &mut Try) -> Run {
    t.out.truncate(from);
    for i in from..log.len() {
        let e = &log[i];
        if hidden(e.action) {
            if e.outcome.is_none() {
                t.snaps[i] = Some(s.clone());
                if !t.pinned[i] && !t.val[i].is_some_and(|o| outcome_ok(&s, e.action, o)) {
                    t.val[i] = match (t.salt, e.action) {
                        (0, _) => default_outcome(&s, e.action),
                        (salt, Action::MoveRobber { victim, .. }) => drawn(&s.players[victim as usize].hand, salt ^ i as u64),
                        _ => default_outcome(&s, e.action),
                    };
                }
            }
            let msg = match (e.action, t.val[i]) {
                (Action::Roll, None) => Some("a roll needs its number"),
                (_, None) => Some("nothing to take"),
                (Action::Roll, Some(o)) if !outcome_ok(&s, e.action, o) => Some("dice run from 1 to 6"),
                _ => None,
            };
            if let Some(m) = msg {
                return Run { state: s, fault: Some((i, m.into())) };
            }
        }
        if !monopoly_mismatch(&s, e.action, e.took).is_empty() {
            return Run { state: s, fault: Some((i, "the cards handed over don't add up".into())) };
        }
        match step(&mut s, e.action, t.val[i]) {
            Ok(o) => t.out.push(o),
            Err(m) => return Run { state: s, fault: Some((i, m)) },
        }
    }
    Run { state: s, fault: None }
}

/// Types every card bought unseen before the replay: a card is pinned down by its play, so each play takes the
/// earliest card its seat bought on an earlier turn (one bought seen, of that kind, first), and the cards never played
/// are dealt from what is left of the deck. Every entry after the opening is the turn player's or answers it, and the
/// turn passes in seat order from seat 0, so the buyer of a card is known without replaying.
fn type_dev_cards(log: &[Entry], n: usize) -> Vec<Option<Outcome>> {
    let mut deck = crate::public::DEV_DECK;
    let mut out: Vec<Option<Outcome>> = log.iter().map(|e| e.outcome.filter(|_| e.action == Action::BuyDev)).collect();
    let mut turn = 0;
    let mut buys: Vec<(usize, usize, usize)> = vec![]; // (entry, turn, seat), not yet matched to a play
    for (i, e) in log.iter().enumerate() {
        let card = match e.action {
            Action::BuyDev => {
                if let Some((c, _)) = e.outcome {
                    deck[c.clamp(0, 4) as usize] -= 1;
                }
                buys.push((i, turn, turn % n));
                None
            }
            Action::PlayKnight => Some(KNIGHT),
            Action::PlayYop(..) => Some(YEAR_OF_PLENTY),
            Action::PlayMonopoly(_) => Some(MONOPOLY),
            Action::PlayRoadBuilding => Some(ROAD_BUILDING),
            Action::EndTurn => {
                turn += 1;
                None
            }
            _ => None,
        };
        let Some(c) = card else { continue };
        let usable = |&(b, t, seat): &(usize, usize, usize)| seat == turn % n && t < turn && out[b].map_or(true, |o| o.0 == c as i32);
        let pick = buys.iter().position(|b| usable(b) && out[b.0].is_some()).or_else(|| buys.iter().position(usable));
        if let Some(k) = pick {
            let (b, _, _) = buys.remove(k);
            if out[b].is_none() {
                out[b] = Some((c as i32, -1));
                deck[c] -= 1;
            }
        }
    }
    for (b, _, _) in buys {
        if out[b].is_none() {
            let c = DEV_ORDER.into_iter().find(|&c| deck[c] > 0).unwrap_or(KNIGHT);
            deck[c] -= 1;
            out[b] = Some((c as i32, -1));
        }
    }
    out
}

/// Replays `log` from `start`, typing its hidden entries so that every entry is legal; `hints` (the outcomes a
/// previous resolve gave the same entries) are tried first. Returns the state reached, the outcome of every entry
/// replayed (enough for `State::apply` to replay it again exactly), and the first entry no typing made legal, if any
/// (the state and outcomes then stop just before it).
///
/// Cards bought unseen are typed up front (`type_dev_cards`). Steals are typed by a local search driven by the entry
/// that fails and the cards its seats are short of: retype one recent steal touching those seats so it gets further;
/// failing that, follow the retype to where it now fails and retype once more there (a seat that stole the card it
/// needs from a seat that had itself stolen it); failing that, take a retype that does no worse and hasn't been tried.
pub fn resolve(start: &State, log: &[Entry], hints: &[Outcome]) -> (State, Vec<Outcome>, Option<Fault>) {
    let devs = type_dev_cards(log, start.n);
    let mut best: Option<(Try, Run)> = None;
    // A search can settle into a typing that no single chain of retypes leaves; then it starts over from steals typed
    // at random (by the victims' hands, as a steal draws), a few times, before an entry is called wrong.
    for salt in 0..=RESTARTS {
        let mut cx = Search { log, budget: if salt == 0 { RUNS } else { RUNS / 2 } };
        let mut t = Try {
            salt,
            val: (0..log.len()).map(|i| log[i].outcome.or(devs[i]).or(if salt == 0 && cx.open(i) { hints.get(i).copied() } else { None })).collect(),
            pinned: vec![false; log.len()],
            snaps: vec![None; log.len()],
            out: Vec::with_capacity(log.len()),
        };
        let mut r = run(start.clone(), 0, log, &mut t);
        let mut tried = std::collections::HashSet::new();
        tried.insert(t.val.clone());
        while r.fault.is_some() && cx.budget > 0 {
            let base = cx.score(&t, &r);
            let found = cx.deepen(&t, &r, base, DEPTH, &tried);
            let Some((t2, r2)) = found.or_else(|| cx.sideways(&t, &r, base, &tried)) else { break };
            tried.insert(t2.val.clone());
            (t, r) = (t2, r2);
        }
        let solved = r.fault.is_none();
        // the first attempt's fault is the one reported: later ones start from guesses, not from the table's log
        if best.is_none() || solved {
            best = Some((t, r));
        }
        let stuck = best.as_ref().is_some_and(|(t, r)| r.fault.as_ref().is_some_and(|f| needs(&r.state, &log[f.0], t.val[f.0]).is_empty()));
        if solved || stuck {
            break;
        }
    }
    let (t, r) = best.expect("one attempt");
    let fault = r.fault.map(|(at, message)| Fault { at, message });
    (r.state, t.out, fault)
}

struct Search<'a> {
    log: &'a [Entry],
    /// Replays left before the failing entry is reported as wrong.
    budget: usize,
}

impl Search<'_> {
    fn open(&self, i: usize) -> bool {
        self.log[i].outcome.is_none() && matches!(self.log[i].action, Action::MoveRobber { victim, .. } if victim >= 0)
    }

    /// How far a typing gets: the entry that fails, then fewer cards short there.
    fn score(&self, t: &Try, r: &Run) -> (usize, usize) {
        match &r.fault {
            None => (usize::MAX, usize::MAX),
            Some((j, _)) => (*j, usize::MAX - needs(&r.state, &self.log[*j], t.val[*j]).len()),
        }
    }

    /// The retypes of the steals up to the failing entry (a pinned steal can be the one that fails) that move a short
    /// seat toward its need, latest first, as (entry, type); empty when the entry would fail whatever the cards.
    fn moves(&self, t: &Try, r: &Run) -> Vec<(usize, i32)> {
        let Some((at, _)) = r.fault else { return vec![] };
        let need = needs(&r.state, &self.log[at], t.val[at]);
        let mut out = vec![];
        let mut seen = 0;
        for i in (0..=at).rev().filter(|&i| self.open(i)) {
            let (Some(sn), Some(cur)) = (t.snaps[i].as_ref(), t.val[i]) else { continue };
            let before = out.len();
            for &(seat, nd) in &need {
                for x in fixes(sn, self.log[i].action, cur.0, seat, nd) {
                    if !out.contains(&(i, x)) {
                        out.push((i, x));
                    }
                }
            }
            seen += (out.len() > before) as usize;
            if seen >= REACH {
                break;
            }
        }
        out
    }

    fn apply(&mut self, t: &Try, (i, x): (usize, i32)) -> (Try, Run) {
        self.budget = self.budget.saturating_sub(1);
        let mut t2 = t.clone();
        t2.val[i] = Some((x, -1));
        t2.pinned[i] = true;
        let r2 = run(t.snaps[i].clone().expect("a hidden steal reached"), i, self.log, &mut t2);
        (t2, r2)
    }

    /// A retype that gets further than `base`, following each one that doesn't to where it now fails and retyping
    /// again there, `depth` deep: a seat that stole the card it needs from a seat that had itself stolen it.
    fn deepen(&mut self, t: &Try, r: &Run, base: (usize, usize), depth: usize, tried: &std::collections::HashSet<Vec<Option<Outcome>>>) -> Option<(Try, Run)> {
        for m in self.moves(t, r) {
            if self.budget == 0 {
                return None;
            }
            let (t2, r2) = self.apply(t, m);
            if tried.contains(&t2.val) {
                continue;
            }
            if self.score(&t2, &r2) > base {
                return Some((t2, r2));
            }
            if depth > 1 && r2.fault.is_some() {
                if let Some(found) = self.deepen(&t2, &r2, base, depth - 1, tried) {
                    return Some(found);
                }
            }
        }
        None
    }

    /// A retype that does no worse and hasn't been tried, to search on from.
    fn sideways(&mut self, t: &Try, r: &Run, base: (usize, usize), tried: &std::collections::HashSet<Vec<Option<Outcome>>>) -> Option<(Try, Run)> {
        for m in self.moves(t, r) {
            if self.budget == 0 {
                return None;
            }
            let (t2, r2) = self.apply(t, m);
            if !tried.contains(&t2.val) && self.score(&t2, &r2) == base {
                return Some((t2, r2));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Layout;
    use crate::map::Map;
    use std::sync::Arc;

    fn layout() -> Layout {
        serde_json::from_str(include_str!("base_layout.json")).unwrap()
    }

    fn splitmix(x: &mut u64) -> u64 {
        *x = x.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = *x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    /// Random games, logged as a person at seat `me` would see them (other seats' steals between each other and their
    /// cards bought untyped; monopolies with what each seat handed over), resolve without a fault to a position that
    /// agrees with the real one on everything public and on `me`'s own hand.
    #[test]
    fn hidden_entries_resolve_to_the_public_position() {
        let layout = layout();
        let mut retyped = 0;
        let mut fails = vec![];
        for seed in 0..200u64 {
            let map = Arc::new(Map::generate(seed, &layout));
            let start = State::new(map, 4, seed, 10);
            let me = (seed % 4) as usize;
            let mut s = start.clone();
            let mut rng = seed ^ 0x5EED;
            let mut log = vec![];
            while s.winner() < 0 && log.len() < 1500 {
                let legal: Vec<Action> = s.playable_actions().into_iter().filter(|a| !matches!(a, Action::OfferTrade { .. })).collect();
                let a = legal[(splitmix(&mut rng) % legal.len() as u64) as usize];
                let p = s.current_player;
                let took = match a {
                    Action::PlayMonopoly(r) => Some(std::array::from_fn(|v| if v < s.n && v != p { s.players[v].hand[r as usize] } else { 0 })),
                    _ => None,
                };
                let o = s.apply(a, None).unwrap();
                let seen = match a {
                    Action::BuyDev => p == me,
                    Action::MoveRobber { victim, .. } if victim >= 0 => p == me || victim as usize == me,
                    _ => true,
                };
                if !seen && o != (-1, -1) {
                    retyped += 1;
                }
                log.push(Entry { action: a, outcome: if seen { Some(o) } else { None }, took });
            }
            let (got, outs, fault) = resolve(&start, &log, &[]);
            if fault.is_some() { fails.push(seed); continue; }
            assert_eq!(outs.len(), log.len());
            assert_eq!(got.players[me].hand, s.players[me].hand, "seed {seed}: my hand");
            assert_eq!(got.players[me].devs, s.players[me].devs, "seed {seed}: my cards");
            assert_eq!(got.bank, s.bank, "seed {seed}");
            assert_eq!(got.owner, s.owner, "seed {seed}");
            assert_eq!(got.road_owner, s.road_owner, "seed {seed}");
            for p in 0..4 {
                assert_eq!(got.num_resources(p), s.num_resources(p), "seed {seed} seat {p}: cards held");
                assert_eq!(got.players[p].devs.iter().sum::<i32>(), s.players[p].devs.iter().sum::<i32>(), "seed {seed} seat {p}: dev cards held");
                assert_eq!(got.players[p].played, s.players[p].played, "seed {seed} seat {p}");
                assert_eq!(got.players[p].vp, s.players[p].vp, "seed {seed} seat {p}: public VP");
            }
            // Replaying the resolved outcomes is the same game, exactly.
            let mut again = start.clone();
            for (e, &o) in log.iter().zip(&outs) {
                again.apply(e.action, Some(o)).unwrap();
            }
            assert_eq!(again.players[me].hand, got.players[me].hand);
            assert_eq!(again.bank, got.bank);
        }
        assert!(retyped > 100, "the games had hidden entries to type ({retyped})");
        assert!(fails.is_empty(), "faults on seeds {fails:?}");
    }

    /// A mistyped entry is reported at its own index, with the position just before it.
    #[test]
    fn an_illegal_entry_is_a_fault_at_its_index() {
        let layout = layout();
        let start = State::new(Arc::new(Map::generate(1, &layout)), 4, 1, 10);
        let mut s = start.clone();
        let mut log = vec![];
        for _ in 0..3 {
            let a = s.playable_actions()[0];
            log.push(Entry { action: a, outcome: Some(s.apply(a, None).unwrap()), took: None });
        }
        let bad = Entry { action: Action::BuildCity(0), outcome: None, took: None };
        log.push(bad);
        let (st, outs, fault) = resolve(&start, &log, &[]);
        assert_eq!(fault.map(|f| f.at), Some(3));
        assert_eq!(outs.len(), 3);
        assert_eq!(st.owner, s.owner);
    }

    /// Random games as `me` sees them, cut at a turn where the seat on move holds 5+ cards but not a city's, which
    /// then claims a city: resolving that (fixed or reported) stays fast however the search goes.
    #[test]
    fn a_doubtful_entry_resolves_quickly() {
        let layout = layout();
        let (mut worst, mut cases) = (std::time::Duration::ZERO, 0);
        for seed in 0..60u64 {
            let start = State::new(Arc::new(Map::generate(seed, &layout)), 4, seed, 10);
            let me = 0;
            let mut s = start.clone();
            let mut rng = seed ^ 0xD0B7;
            let mut log = vec![];
            while s.winner() < 0 && log.len() < 800 {
                let p = s.current_player;
                if log.len() > 300 && p != me && s.prompt == Prompt::PlayTurn && s.players[p].has_rolled && !s.players[p].settlements.is_empty()
                    && s.num_resources(p) >= 5 && (s.players[p].hand[WHEAT] < 2 || s.players[p].hand[ORE] < 3) {
                    log.push(Entry { action: Action::BuildCity(s.players[p].settlements[0]), outcome: None, took: None });
                    let t0 = std::time::Instant::now();
                    let _ = resolve(&start, &log, &[]);
                    worst = worst.max(t0.elapsed());
                    cases += 1;
                    break;
                }
                let legal: Vec<Action> = s.playable_actions().into_iter().filter(|a| !matches!(a, Action::OfferTrade { .. })).collect();
                let a = legal[(splitmix(&mut rng) % legal.len() as u64) as usize];
                let o = s.apply(a, None).unwrap();
                let seen = match a {
                    Action::BuyDev => p == me,
                    Action::MoveRobber { victim, .. } if victim >= 0 => p == me || victim as usize == me,
                    _ => true,
                };
                let took = None; // no monopolies matter here
                log.push(Entry { action: a, outcome: if seen { Some(o) } else { None }, took });
            }
        }
        eprintln!("{cases} doubtful entries, worst {worst:?}");
        assert!(cases > 10);
        assert!(worst.as_millis() < 500, "worst {worst:?}");
    }

    #[test]
    fn a_board_off_the_table_is_checked() {
        let layout = layout();
        let m = Map::generate(7, &layout);
        let tiles: [i8; 19] = std::array::from_fn(|t| m.tiles[t].resource);
        let mut numbers: [u8; 19] = std::array::from_fn(|t| m.tiles[t].number);
        let ports: [i8; 9] = std::array::from_fn(|p| m.ports[p].resource);
        assert!(Map::from_board(&tiles, &numbers, &ports, &layout).is_ok());
        // any placement of the same tokens is a board
        let land: Vec<usize> = (0..19).filter(|&t| tiles[t] >= 0).collect();
        numbers.swap(land[0], land[5]);
        assert!(Map::from_board(&tiles, &numbers, &ports, &layout).is_ok());
        let mut two = numbers;
        two[land[0]] = 2;
        two[land[1]] = 2;
        assert!(Map::from_board(&tiles, &two, &ports, &layout).is_err(), "two 2s");
        let mut no_desert = tiles;
        no_desert[(0..19).find(|&t| tiles[t] < 0).unwrap()] = 0;
        assert!(Map::from_board(&no_desert, &numbers, &ports, &layout).is_err());
        let mut port = ports;
        port[0] = port[1];
        assert!(Map::from_board(&tiles, &numbers, &port, &layout).is_err());
    }
}

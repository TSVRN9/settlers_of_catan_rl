//! The compact game record behind a shared link (docs/superpowers/specs/2026-10-11-mobile-ui-design.md, "Open
//! questions"). The browser deflate-raws and base64urls these bytes into `#/r/<code>`; nothing here knows about that.
//!
//! Version 1:
//! - header: the version byte, a varint seed, the seat count; then sections, each a tag byte, a varint length and its
//!   payload, ended by tag 0. Sections are the browser's (tag 1 = seats); a decoder skips them all, so a section can be
//!   added without a version bump.
//! - then per step, to the end of the bytes: the varint index of the action in that step's `playable_actions()`, or
//!   that list's length as an escape followed by an offer's give and get counts (5 bytes each: a person's offer can be
//!   bigger than the two-card bundles the list holds); then one byte where the action has a random outcome: a roll as
//!   (d1-1)*6 + (d2-1), a development card drawn as its type + 1, a robber move as the resource stolen + 1 (0 for none).
//!   A discard names its resource in the action, so it carries none.
//!
//! The legal-action order is part of the format: a change to it changes the bytes (the golden test below fails), and
//! that is a version bump.
use std::sync::Arc;

use crate::actions::Action;
use crate::apply::Outcome;
use crate::encode::Layout;
use crate::map::Map;
use crate::state::State;

pub const VERSION: u8 = 1;
/// A decoded game longer than this is not a game (the longest measured bot game is 715 steps).
pub const MAX_STEPS: usize = 5000;

/// The game a seed deals: the board, and the state's own random stream. `Engine::new` builds its game here too, so a
/// link and the game it was made from can't disagree about either.
pub fn new_state(seed: u32, n: usize, layout: &Layout) -> State {
    let map = Arc::new(Map::generate(seed as u64, layout));
    State::new(map, n, (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x5851_F42D_4C95_7F2D, 10)
}

fn varint(mut x: u64, out: &mut Vec<u8>) {
    while x >= 0x80 {
        out.push((x as u8 & 0x7f) | 0x80);
        x >>= 7;
    }
    out.push(x as u8);
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Result<u8, String> {
        let v = *self.b.get(self.at).ok_or("the record ends early")?;
        self.at += 1;
        Ok(v)
    }
    fn varint(&mut self) -> Result<u64, String> {
        let mut x = 0u64;
        for shift in (0..64).step_by(7) {
            let v = self.byte()?;
            x |= ((v & 0x7f) as u64) << shift;
            if v < 0x80 {
                return Ok(x);
            }
        }
        Err("a number in the record is too long".into())
    }
    fn skip(&mut self, n: u64) -> Result<(), String> {
        if n > (self.b.len() - self.at) as u64 {
            return Err("a section runs past the end".into());
        }
        self.at += n as usize;
        Ok(())
    }
    fn done(&self) -> bool {
        self.at >= self.b.len()
    }
}

/// Walks the sections up to and including the closing tag 0.
fn skip_sections(r: &mut Reader) -> Result<(), String> {
    loop {
        if r.byte()? == 0 {
            return Ok(());
        }
        let len = r.varint()?;
        r.skip(len)?;
    }
}

/// The outcome byte an action carries, if any.
fn outcome_byte(a: Action, o: Outcome) -> Result<Option<u8>, String> {
    Ok(match a {
        Action::Roll if (1..=6).contains(&o.0) && (1..=6).contains(&o.1) => Some(((o.0 - 1) * 6 + (o.1 - 1)) as u8),
        Action::Roll => return Err(format!("dice {o:?}")),
        Action::BuyDev if (0..5).contains(&o.0) => Some((o.0 + 1) as u8),
        Action::BuyDev => return Err(format!("card {o:?}")),
        Action::MoveRobber { .. } if (-1..5).contains(&o.0) => Some((o.0 + 1) as u8),
        Action::MoveRobber { .. } => return Err(format!("steal {o:?}")),
        _ => None,
    })
}

fn outcome_of(a: Action, b: u8) -> Result<Outcome, String> {
    Ok(match a {
        Action::Roll if b < 36 => ((b / 6 + 1) as i32, (b % 6 + 1) as i32),
        Action::BuyDev if (1..=5).contains(&b) => (b as i32 - 1, -1),
        Action::MoveRobber { .. } if b <= 5 => (b as i32 - 1, -1),
        _ => return Err(format!("outcome byte {b} for {a:?}")),
    })
}

/// The bytes of a played game. `sections` are well-formed sections (no closing tag); `log` is the game's own
/// (action, outcome) per step, as `Engine::record` keeps it.
pub fn encode(seed: u32, n: usize, sections: &[u8], log: &[(Action, Outcome)], layout: &Layout) -> Result<Vec<u8>, String> {
    let mut check = Reader { b: sections, at: 0 };
    while !check.done() {
        if check.byte()? == 0 {
            return Err("a section's tag is 0".into());
        }
        let len = check.varint()?;
        check.skip(len)?;
    }
    let mut out = vec![VERSION];
    varint(seed as u64, &mut out);
    out.push(n as u8);
    out.extend_from_slice(sections);
    out.push(0);
    let mut state = new_state(seed, n, layout);
    for (step, &(a, o)) in log.iter().enumerate() {
        let legal = state.playable_actions();
        match legal.iter().position(|&x| x == a) {
            Some(i) => varint(i as u64, &mut out),
            None => match a {
                Action::OfferTrade { give, get } => {
                    varint(legal.len() as u64, &mut out);
                    out.extend_from_slice(&give);
                    out.extend_from_slice(&get);
                }
                _ => return Err(format!("step {step}: {a:?} is not a legal action")),
            },
        }
        let byte = outcome_byte(a, o)?;
        if let Some(b) = byte {
            out.push(b);
        }
        let got = state.apply(a, byte.map(|_| o)).map_err(|e| format!("step {step}: {e}"))?;
        if got != o {
            return Err(format!("step {step}: {a:?} gave {got:?}, the record says {o:?}"));
        }
    }
    Ok(out)
}

/// The game in `bytes`: its seed, seat count and log. Anything malformed, illegal or too long is an error, never a
/// panic: these bytes come from a link anyone can edit.
pub fn decode(bytes: &[u8], layout: &Layout) -> Result<(u32, usize, Vec<(Action, Outcome)>), String> {
    let mut r = Reader { b: bytes, at: 0 };
    let v = r.byte()?;
    if v != VERSION {
        return Err(format!("record version {v}"));
    }
    let seed = u32::try_from(r.varint()?).map_err(|_| "the seed is out of range")?;
    let n = r.byte()? as usize;
    if !(2..=4).contains(&n) {
        return Err(format!("{n} seats"));
    }
    skip_sections(&mut r)?;
    let mut state = new_state(seed, n, layout);
    let mut log = Vec::new();
    while !r.done() {
        if log.len() >= MAX_STEPS {
            return Err("the record is too long".into());
        }
        if state.winner() >= 0 {
            return Err("the record goes on after the game ended".into());
        }
        let legal = state.playable_actions();
        let i = r.varint()?;
        let a = if i < legal.len() as u64 {
            legal[i as usize]
        } else if i == legal.len() as u64 {
            let mut give = [0u8; 5];
            let mut get = [0u8; 5];
            for c in give.iter_mut().chain(get.iter_mut()) {
                *c = r.byte()?;
                // 19 of a resource is all the bank has; the canonical form packs a count in 5 bits.
                if *c > 19 {
                    return Err(format!("step {}: an offer of {c}, more cards than the game has", log.len()));
                }
            }
            Action::OfferTrade { give, get }
        } else {
            return Err(format!("step {}: action {i} of {}", log.len(), legal.len()));
        };
        let forced = if matches!(a, Action::Roll | Action::BuyDev | Action::MoveRobber { .. }) { Some(outcome_of(a, r.byte()?)?) } else { None };
        let o = state.apply(a, forced).map_err(|e| format!("step {}: {e}", log.len()))?;
        log.push((a, o));
    }
    Ok((seed, n, log))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trade::Eval;

    fn layout() -> Layout {
        serde_json::from_str(include_str!("base_layout.json")).unwrap()
    }

    /// A game played by the depth-1 heuristic with its trade policy, as `Engine` logs it; with `big_offer`, the first
    /// seat after its roll holding three of a kind offers them for one card, an offer outside the legal list.
    fn play(seed: u32, n: usize, big_offer: bool, layout: &Layout) -> (Vec<(Action, Outcome)>, bool) {
        let mut s = new_state(seed, n, layout);
        let mut log = vec![];
        let mut offered = false;
        while s.winner() < 0 && log.len() < 3000 {
            let p = s.current_player;
            let pl = &s.players[p];
            let three = (0..5).find(|&r| pl.hand[r] >= 3);
            let a = match three {
                Some(r) if big_offer && !offered && s.prompt == crate::state::Prompt::PlayTurn && pl.has_rolled && !s.is_resolving_trade && !s.is_road_building => {
                    offered = true;
                    let mut give = [0u8; 5];
                    let mut get = [0u8; 5];
                    give[r] = 3;
                    get[(r + 1) % 5] = 1;
                    Action::OfferTrade { give, get }
                }
                _ => s.trade_action(&Eval::Heuristic).or_else(|| s.decide_heuristic(1)).unwrap_or(s.playable_actions()[0]),
            };
            let o = s.apply(a, None).unwrap();
            log.push((a, o));
        }
        (log, offered)
    }

    #[test]
    fn round_trips_played_games() {
        let layout = layout();
        let seats = [1u8, 4, 3, 2, 3, 2, 0, 0, 2, 0, 0, 3, 2, 0];
        let sections = [&[1u8, seats.len() as u8][..], &seats].concat();
        let mut offers = 0;
        for (k, seed) in [7u32, 11, 4242, 90001, 3, 123456789].into_iter().enumerate() {
            let n = 2 + k % 3;
            let (log, offered) = play(seed, n, k % 2 == 0, &layout);
            offers += offered as usize;
            let bytes = encode(seed, n, &sections, &log, &layout).unwrap();
            let (s2, n2, log2) = decode(&bytes, &layout).unwrap();
            assert_eq!((s2, n2), (seed, n));
            assert_eq!(log2, log, "seed {seed}");
            assert!(bytes.len() < 4 * log.len() + 32, "{} bytes for {} steps", bytes.len(), log.len());
        }
        assert!(offers > 0, "an offer outside the legal list was exercised");
    }

    #[test]
    fn skips_sections_it_does_not_know() {
        let layout = layout();
        let (log, _) = play(5, 4, false, &layout);
        let plain = encode(5, 4, &[], &log, &layout).unwrap();
        let extra = encode(5, 4, &[9, 3, 0xff, 0x00, 0x7f, 1, 0], &log, &layout).unwrap();
        assert_eq!(decode(&extra, &layout).unwrap(), decode(&plain, &layout).unwrap());
        assert!(encode(5, 4, &[0, 1, 2], &log, &layout).is_err(), "a section tagged 0 would end the header early");
    }

    #[test]
    fn rejects_what_is_not_a_game() {
        let layout = layout();
        let (log, _) = play(9, 4, false, &layout);
        assert!(new_state(9, 4, &layout).winner() < 0 && log.len() < 3000, "the game ended");
        let bytes = encode(9, 4, &[], &log, &layout).unwrap();
        for cut in 0..4 {
            assert!(decode(&bytes[..cut], &layout).is_err(), "a header cut at {cut}");
        }
        for cut in 4..bytes.len() {
            let _ = decode(&bytes[..cut], &layout); // an unfinished game, or an error: never a panic
        }
        assert!(decode(&[2, 9, 4, 0], &layout).is_err(), "another version");
        assert!(decode(&[1, 9, 7, 0], &layout).is_err(), "seven seats");
        assert!(decode(&[1, 9, 4, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01], &layout).is_err(), "a number too long");
        assert!(decode(&[1, 9, 4, 0, 120], &layout).is_err(), "an index past the legal list");
        assert!(decode(&[1, 9, 4, 5, 200, 1], &layout).is_err(), "a section past the end");
        let mut garbled = bytes.clone();
        for b in garbled.iter_mut().skip(6).step_by(3) {
            *b ^= 0x5a;
        }
        assert!(decode(&garbled, &layout).is_err(), "garbled bytes");
        // An offer past what any hand could hold (the canon packs 5 bits a count) is refused before the rules see it.
        let legal0 = new_state(9, 4, &layout).playable_actions().len() as u8;
        let big = decode(&[1, 9, 4, 0, legal0, 0, 0, 0, 0, 25, 1, 0, 0, 0, 0], &layout);
        assert!(big.as_ref().is_err_and(|e| e.contains("more cards than")), "{big:?}");
        // A game run past its end, and a dev card the deck doesn't hold, are both refused.
        let mut long = bytes.clone();
        long.push(0);
        assert!(decode(&long, &layout).is_err(), "a step after the winner");
    }

    /// One fixed game's bytes, as links made with version 1 carry them (`compact_golden_v1.bin`, written once by the
    /// ignored test above). If this fails, the format moved under existing links — the legal-action order, the outcome
    /// bytes, the map or the rules — and that is a VERSION bump. A change to the bots doesn't touch it.
    #[test]
    fn golden() {
        let layout = layout();
        let bytes = include_bytes!("compact_golden_v1.bin");
        let (seed, n, log) = decode(bytes, &layout).unwrap();
        let hash = log.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, (a, o)| {
            let (t, x, y, z) = crate::actions::to_canon(*a);
            format!("{t}{x},{y},{z};{},{}", o.0, o.1).bytes().fold(h, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3))
        });
        assert_eq!((seed, n, log.len(), hash), (2026, 4, 410, 5108269858681490506));
        assert_eq!(encode(seed, n, &[], &log, &layout).unwrap(), bytes.to_vec(), "the same game encodes to the same bytes");
    }
}

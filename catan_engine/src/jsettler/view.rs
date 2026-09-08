//! The JSettlers client's view of every player's resources (see `Views`).

use crate::state::Event;

/// SOCPlayer.getResources() as the JSettlers client keeps it for each seat: five known counts in
/// engine order and, at index 5, the UNKNOWN count. Arithmetic is SOCResourceSet's: `add` is plain;
/// `subtract(amt, type, true)` takes the excess of a known type from UNKNOWN, and a loss of UNKNOWN
/// type first converts every known card to UNKNOWN (SOCDisplaylessPlayerClient
/// .handlePLAYERELEMENT_numRsrc, SOCResourceSet.subtract / convertToUnknown).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Views(pub Vec<[i32; 6]>);

impl Views {
    pub fn new(n: usize) -> Views {
        Views(vec![[0; 6]; n])
    }

    /// Start from exact hands (a client joining at the first decision knows the start resources).
    pub fn from_hands(hands: &[[i32; 5]]) -> Views {
        Views(hands.iter().map(|h| [h[0], h[1], h[2], h[3], h[4], 0]).collect())
    }

    pub fn gain(&mut self, seat: usize, res: &[i8; 5]) {
        for r in 0..5 {
            self.0[seat][r] += res[r] as i32;
        }
    }

    pub fn lose(&mut self, seat: usize, res: &[i8; 5]) {
        for r in 0..5 {
            let amt = res[r] as i32;
            let known = self.0[seat][r];
            if amt > known {
                self.0[seat][5] -= amt - known;
                self.0[seat][r] = 0;
            } else {
                self.0[seat][r] -= amt;
            }
        }
    }

    /// convertToUnknown: every known card becomes UNKNOWN.
    pub fn hide(&mut self, seat: usize) {
        let known: i32 = self.0[seat][..5].iter().sum();
        self.0[seat] = [0, 0, 0, 0, 0, self.0[seat][5] + known];
    }

    pub fn known(&self, seat: usize) -> [i32; 5] {
        let v = self.0[seat];
        [v[0], v[1], v[2], v[3], v[4]]
    }

    /// What the server tells seat `us` about this event.
    pub fn apply(&mut self, e: &Event, us: usize) {
        let one = |r: u8| {
            let mut d = [0i8; 5];
            d[r as usize] = 1;
            d
        };
        match *e {
            Event::Gain { seat, res } => self.gain(seat as usize, &res),
            Event::Lose { seat, res } => self.lose(seat as usize, &res),
            Event::Discard { seat } => {
                if seat as usize != us {
                    self.hide(seat as usize);
                    self.0[seat as usize][5] -= 1;
                }
            }
            Event::Steal { thief, victim, res } => {
                let (t, v) = (thief as usize, victim as usize);
                if t == us || v == us {
                    self.lose(v, &one(res));
                    self.gain(t, &one(res));
                } else {
                    self.hide(v);
                    self.0[v][5] -= 1;
                    self.0[t][5] += 1;
                }
            }
            Event::Offer { .. } | Event::Reply { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_client_arithmetic() {
        let mut v = Views::from_hands(&[[2, 0, 0, 0, 0], [1, 1, 0, 0, 0], [0; 5], [0; 5]]);
        // a public loss beyond the known count comes out of UNKNOWN (SOCResourceSet.subtract)
        v.0[1] = [1, 1, 0, 0, 0, 2];
        v.lose(1, &[2, 0, 0, 0, 0]);
        assert_eq!(v.0[1], [0, 1, 0, 0, 0, 1]);
        // another seat's discard hides its whole hand first (convertToUnknown), then takes one
        v.apply(&Event::Discard { seat: 1 }, 0);
        assert_eq!(v.0[1], [0, 0, 0, 0, 0, 1]);
        // our own discard is exact for us: ignored here (the brain overwrites our row)
        v.apply(&Event::Discard { seat: 0 }, 0);
        assert_eq!(v.0[0], [2, 0, 0, 0, 0, 0]);
        // a steal between two other seats: victim hidden minus one, thief plus one unknown
        v.0[2] = [0, 0, 3, 0, 0, 0];
        v.apply(&Event::Steal { thief: 3, victim: 2, res: 2 }, 0);
        assert_eq!(v.0[2], [0, 0, 0, 0, 0, 2]);
        assert_eq!(v.0[3], [0, 0, 0, 0, 0, 1]);
        // a steal we are party to is exact
        v.apply(&Event::Steal { thief: 0, victim: 3, res: 2 }, 0);
        assert_eq!(v.0[3], [0, 0, 0, 0, 0, 0], "excess of a known type comes out of UNKNOWN");
        assert_eq!(v.known(0), [2, 0, 1, 0, 0]);
        // gains are plain
        v.apply(&Event::Gain { seat: 2, res: [0, 1, 0, 0, 0] }, 0);
        assert_eq!(v.0[2], [0, 1, 0, 0, 0, 2]);
    }
}

//! The two Java collections whose iteration order the robot's choices depend on: `HashSet<Integer>`
//! (buckets by value, insertion order within a bucket) and `Hashtable<Integer,_>` (buckets by
//! value modulo an odd capacity, newest first within a bucket, enumerated from the last bucket down,
//! rehashed when full). Ties in the strategies' argmax loops fall to whichever key comes first.

/// java.util.HashSet<Integer> at a fixed power-of-two capacity (128 holds every board coordinate
/// without a resize): bucket = value & (cap - 1), a bucket keeps insertion order.
#[derive(Clone, Debug)]
pub struct JSet {
    buckets: Vec<Vec<i32>>,
    len: usize,
}

impl JSet {
    pub fn new() -> JSet {
        JSet { buckets: vec![Vec::new(); 128], len: 0 }
    }

    pub fn from_iter<I: IntoIterator<Item = i32>>(it: I) -> JSet {
        let mut s = JSet::new();
        for v in it {
            s.insert(v);
        }
        s
    }

    fn bucket(v: i32) -> usize {
        ((v as u32 ^ (v as u32 >> 16)) & 127) as usize
    }

    pub fn contains(&self, v: &i32) -> bool {
        self.buckets[JSet::bucket(*v)].contains(v)
    }

    pub fn insert(&mut self, v: i32) -> bool {
        let b = &mut self.buckets[JSet::bucket(v)];
        if b.contains(&v) {
            return false;
        }
        b.push(v);
        self.len += 1;
        true
    }

    pub fn remove(&mut self, v: &i32) -> bool {
        let b = &mut self.buckets[JSet::bucket(*v)];
        if let Some(i) = b.iter().position(|x| x == v) {
            b.remove(i);
            self.len -= 1;
            true
        } else {
            false
        }
    }

    pub fn clear(&mut self) {
        for b in &mut self.buckets {
            b.clear();
        }
        self.len = 0;
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Java's iteration order.
    pub fn iter(&self) -> impl Iterator<Item = &i32> {
        self.buckets.iter().flat_map(|b| b.iter())
    }
}

impl Default for JSet {
    fn default() -> JSet {
        JSet::new()
    }
}

/// java.util.Hashtable<Integer, V> with the default capacity 11 and load factor 0.75.
#[derive(Clone, Debug)]
pub struct JTable<V: Clone> {
    buckets: Vec<Vec<(i32, V)>>, // each bucket newest first
    count: usize,
    threshold: usize,
}

impl<V: Clone> JTable<V> {
    pub fn new() -> JTable<V> {
        JTable { buckets: vec![Vec::new(); 11], count: 0, threshold: 8 }
    }

    fn index(&self, k: i32) -> usize {
        ((k as u32 & 0x7FFF_FFFF) % self.buckets.len() as u32) as usize
    }

    pub fn get(&self, k: i32) -> Option<&V> {
        self.buckets[self.index(k)].iter().find(|(x, _)| *x == k).map(|(_, v)| v)
    }

    pub fn contains_key(&self, k: i32) -> bool {
        self.get(k).is_some()
    }

    pub fn put(&mut self, k: i32, v: V) {
        let i = self.index(k);
        if let Some(e) = self.buckets[i].iter_mut().find(|(x, _)| *x == k) {
            e.1 = v;
            return;
        }
        if self.count >= self.threshold {
            self.rehash();
        }
        let i = self.index(k);
        self.buckets[i].insert(0, (k, v));
        self.count += 1;
    }

    pub fn remove(&mut self, k: i32) {
        let i = self.index(k);
        if let Some(p) = self.buckets[i].iter().position(|(x, _)| *x == k) {
            self.buckets[i].remove(p);
            self.count -= 1;
        }
    }

    /// Hashtable.rehash: new capacity 2n + 1, old buckets walked from the last down, entries moved
    /// to the head of their new bucket.
    fn rehash(&mut self) {
        let new_cap = self.buckets.len() * 2 + 1;
        let old = std::mem::replace(&mut self.buckets, vec![Vec::new(); new_cap]);
        self.threshold = ((new_cap as f32) * 0.75) as usize;
        for bucket in old.into_iter().rev() {
            for (k, v) in bucket {
                let i = ((k as u32 & 0x7FFF_FFFF) % new_cap as u32) as usize;
                self.buckets[i].insert(0, (k, v));
            }
        }
    }

    /// Hashtable.keys(): from the last bucket down, newest first within a bucket.
    pub fn keys(&self) -> Vec<i32> {
        self.buckets.iter().rev().flat_map(|b| b.iter().map(|(k, _)| *k)).collect()
    }
}

impl<V: Clone> Default for JTable<V> {
    fn default() -> JTable<V> {
        JTable::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checked against java.util on the same inputs: a HashSet<Integer>(128) of 0x27, 0xA7, 0x38
    /// iterates 0x27, 0xA7, 0x38; a Hashtable of keys 1..9 enumerates 9 (rehashed at the 9th put)
    /// as 8, 7, 6, 5, 4, 3, 2, 1, 9? no: after the rehash to 23 buckets keys 1..8 sit in buckets 1..8 and
    /// 9 in bucket 9, enumerated 9, 8, ..., 1.
    #[test]
    fn java_orders() {
        let s = JSet::from_iter([0x27, 0xA7, 0x38]);
        assert_eq!(s.iter().copied().collect::<Vec<_>>(), vec![0x27, 0xA7, 0x38]);
        let mut t: JTable<i32> = JTable::new();
        for k in 1..=9 {
            t.put(k, k * 10);
        }
        assert_eq!(t.keys(), vec![9, 8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(t.get(5), Some(&50));
        let mut u: JTable<i32> = JTable::new();
        for k in [3, 14, 25] {
            u.put(k, 0); // all in bucket 3 of 11: newest first
        }
        assert_eq!(u.keys(), vec![25, 14, 3]);
    }
}

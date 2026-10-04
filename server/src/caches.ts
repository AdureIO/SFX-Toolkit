/**
 * Small cache helpers shared by the server modules.
 */

/**
 * Insert into a Map used as an LRU (insertion order = recency) and evict the oldest
 * entries beyond `max`. Every long-lived server cache goes through this so nothing
 * grows without bound over a long session.
 */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest as K);
    }
}

/** Read from an LRU Map, refreshing the entry's recency on a hit. */
export function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
    if (!map.has(key)) return undefined;
    const v = map.get(key) as V;
    map.delete(key);
    map.set(key, v);
    return v;
}

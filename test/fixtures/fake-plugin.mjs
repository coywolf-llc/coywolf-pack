// In-memory stand-ins for EmDash's plugin context pieces (storage collections,
// KV, settings), for tests of modules that only use the plugin APIs. Storage
// honors where (equality, in, startsWith, ranges), orderBy, limit and cursor
// like EmDash's, and enforces D1's 100-bound-parameter limit on id lists.

const MAX_PARAMS = 100;

export function fakeCollection() {
	const rows = new Map();
	/** id → revision, bumped on every write (getVersioned / compareAndSet). */
	const revisions = new Map();
	let rev = 0;
	const bump = (id) => revisions.set(id, String(++rev));
	const params = (where = {}) => 2 + Object.values(where).reduce((n, v) => n + (v && typeof v === "object" && "in" in v ? v.in.length : 1), 0);
	const matches = (data, where = {}) =>
		Object.entries(where).every(([k, cond]) => {
			const v = data[k] ?? null;
			if (cond && typeof cond === "object") {
				if ("in" in cond) return cond.in.includes(v);
				if ("startsWith" in cond) return typeof v === "string" && v.startsWith(cond.startsWith);
				if (v === null) return false;
				return (cond.lt === undefined || v < cond.lt) && (cond.lte === undefined || v <= cond.lte) && (cond.gt === undefined || v > cond.gt) && (cond.gte === undefined || v >= cond.gte);
			}
			return v === cond;
		});
	const check = (n) => {
		if (n > MAX_PARAMS) throw new Error(`too many SQL variables (${n})`);
	};
	return {
		rows,
		writes: 0,
		async get(id) {
			return rows.has(id) ? structuredClone(rows.get(id)) : null;
		},
		async put(id, data) {
			this.writes++;
			rows.set(id, structuredClone(data));
			bump(id);
		},
		async getVersioned(id) {
			return rows.has(id) ? { value: structuredClone(rows.get(id)), revision: revisions.get(id) } : null;
		},
		async compareAndSet(id, expected, data) {
			const current = rows.has(id) ? revisions.get(id) : null;
			if (current !== expected) return { applied: false };
			this.writes++;
			rows.set(id, structuredClone(data));
			bump(id);
			return { applied: true, revision: revisions.get(id) };
		},
		async getMany(ids) {
			check(ids.length + 2);
			return new Map(ids.filter((id) => rows.has(id)).map((id) => [id, structuredClone(rows.get(id))]));
		},
		async putMany(items) {
			this.writes += items.length;
			for (const { id, data } of items) {
				rows.set(id, structuredClone(data));
				bump(id);
			}
		},
		async deleteMany(ids) {
			check(ids.length + 2);
			let n = 0;
			for (const id of ids) if (rows.delete(id)) n++;
			return n;
		},
		async delete(id) {
			return rows.delete(id);
		},
		async count(where) {
			check(params(where));
			return [...rows.values()].filter((d) => matches(d, where)).length;
		},
		async query({ where, orderBy, limit = 50, cursor } = {}) {
			check(params(where));
			const all = [...rows].filter(([, d]) => matches(d, where)).map(([id, data]) => ({ id, data: structuredClone(data) }));
			const [field, dir] = Object.entries(orderBy ?? {})[0] ?? [];
			if (field) all.sort((a, b) => ((a.data[field] ?? "") < (b.data[field] ?? "") ? -1 : (a.data[field] ?? "") > (b.data[field] ?? "") ? 1 : 0) * (dir === "desc" ? -1 : 1));
			const start = cursor ? Number(cursor) : 0;
			const items = all.slice(start, start + Math.min(limit, 100));
			const hasMore = start + items.length < all.length;
			return { items, hasMore, cursor: hasMore ? String(start + items.length) : undefined };
		},
	};
}

export function fakeKv(initial = {}) {
	const map = new Map(Object.entries(initial).map(([k, value]) => [k, { value, revision: "0" }]));
	let rev = 0;
	return {
		map,
		async get(k) {
			return map.has(k) ? structuredClone(map.get(k).value) : null;
		},
		async set(k, value) {
			map.set(k, { value: structuredClone(value), revision: String(++rev) });
		},
		async delete(k) {
			return map.delete(k);
		},
		async getVersioned(k) {
			return map.has(k) ? structuredClone(map.get(k)) : null;
		},
		async compareAndSet(k, expected, value) {
			const cur = map.get(k);
			if ((cur?.revision ?? null) !== expected) return { applied: false };
			const revision = String(++rev);
			map.set(k, { value: structuredClone(value), revision });
			return { applied: true, revision };
		},
		async compareAndDelete(k, expected) {
			if (map.get(k)?.revision !== expected) return { applied: false };
			map.delete(k);
			return { applied: true };
		},
	};
}

/** ctx.settings over a plain object (features under "features"). */
export function fakeSettings(initial = {}) {
	const values = { ...initial };
	return {
		values,
		async get(k) {
			return k in values ? structuredClone(values[k]) : null;
		},
		async set(k, v) {
			values[k] = structuredClone(v);
		},
		async delete(k) {
			delete values[k];
		},
	};
}

export const quietLog = () => {
	const lines = [];
	const add = (level) => (message, data) => lines.push({ level, message, data });
	return { lines, info: add("info"), debug: add("debug"), warn: add("warn"), error: add("error") };
};

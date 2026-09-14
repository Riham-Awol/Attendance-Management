"use strict";

const { ObjectId } = require("mongodb");

/**
 * A small in-memory stand-in for the MongoDB driver.
 *
 * The sandbox this project was built in cannot download a real mongod, so the
 * service-layer tests run against this instead. It implements only the subset
 * of the driver the app actually uses — including unique-index violations,
 * which the check-in path depends on for its double-tap guard. It is a test
 * aid, not a database: anything it cannot express is a signal to test that
 * behaviour against a real MongoDB before relying on it.
 */

const clone = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value);
  if (value instanceof ObjectId) return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
};

const getPath = (doc, path) =>
  path.split(".").reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), doc);

function setPath(doc, path, value) {
  const keys = path.split(".");
  let cursor = doc;
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

const normalize = (value) => {
  if (value instanceof ObjectId) return `oid:${value.toHexString()}`;
  if (value instanceof Date) return value.getTime();
  return value;
};

function compare(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  return x < y ? -1 : 1;
}

const equals = (a, b) => normalize(a) === normalize(b);

function matchesCondition(value, condition) {
  if (condition instanceof ObjectId || condition instanceof Date) return equals(value, condition);
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== "object" || Array.isArray(condition)) return equals(value, condition);

  return Object.entries(condition).every(([op, operand]) => {
    switch (op) {
      case "$eq":
        return equals(value, operand);
      case "$ne":
        return !equals(value, operand);
      case "$in":
        return operand.some((item) => equals(value, item));
      case "$nin":
        return !operand.some((item) => equals(value, item));
      case "$gt":
        return compare(value, operand) > 0;
      case "$gte":
        return compare(value, operand) >= 0;
      case "$lt":
        return compare(value, operand) < 0;
      case "$lte":
        return compare(value, operand) <= 0;
      case "$regex":
        return new RegExp(operand, condition.$options || "").test(String(value ?? ""));
      case "$options":
        return true;
      case "$exists":
        return (value !== undefined) === operand;
      default:
        throw new Error(`memory-mongo: unsupported operator ${op}`);
    }
  });
}

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$or") return condition.some((sub) => matches(doc, sub));
    if (key === "$and") return condition.every((sub) => matches(doc, sub));
    return matchesCondition(getPath(doc, key), condition);
  });
}

function applyUpdate(doc, update) {
  const next = clone(doc);
  for (const [op, fields] of Object.entries(update)) {
    if (op === "$set" || op === "$setOnInsert") {
      for (const [path, value] of Object.entries(fields)) setPath(next, path, clone(value));
    } else if (op === "$inc") {
      for (const [path, value] of Object.entries(fields)) {
        setPath(next, path, (getPath(next, path) || 0) + value);
      }
    } else if (op === "$unset") {
      for (const path of Object.keys(fields)) setPath(next, path, undefined);
    } else {
      throw new Error(`memory-mongo: unsupported update operator ${op}`);
    }
  }
  return next;
}

class Cursor {
  constructor(docs) {
    this.docs = docs;
    this._sort = null;
    this._skip = 0;
    this._limit = Infinity;
    this._projection = null;
  }
  sort(spec) {
    this._sort = spec;
    return this;
  }
  skip(n) {
    this._skip = n;
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  project(spec) {
    this._projection = spec;
    return this;
  }
  async toArray() {
    let out = [...this.docs];
    if (this._sort) {
      const entries = Object.entries(this._sort);
      out.sort((a, b) => {
        for (const [key, dir] of entries) {
          const result = compare(getPath(a, key), getPath(b, key)) * (dir < 0 ? -1 : 1);
          if (result !== 0) return result;
        }
        return 0;
      });
    }
    out = out.slice(this._skip, this._skip === 0 && this._limit === Infinity ? undefined : this._skip + this._limit);
    if (this._projection) {
      const keys = Object.keys(this._projection).filter((k) => k !== "_id");
      const including = keys.some((k) => this._projection[k]);
      out = out.map((doc) => {
        if (!including) {
          const copy = clone(doc);
          for (const key of keys) delete copy[key];
          return copy;
        }
        const picked = this._projection._id === 0 ? {} : { _id: doc._id };
        for (const key of keys) if (doc[key] !== undefined) picked[key] = clone(doc[key]);
        return picked;
      });
    }
    return out.map(clone);
  }
}

class MemoryCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
    this.uniqueIndexes = [];
  }

  async createIndex(spec, options = {}) {
    if (options.unique) {
      this.uniqueIndexes.push({ keys: Object.keys(spec), sparse: !!options.sparse });
    }
    return "ok";
  }

  assertUnique(candidate, excludeId) {
    for (const index of this.uniqueIndexes) {
      const values = index.keys.map((key) => getPath(candidate, key));
      if (index.sparse && values.some((v) => v === undefined || v === null)) continue;
      const clash = this.docs.find(
        (doc) =>
          (excludeId === undefined || !equals(doc._id, excludeId)) &&
          index.keys.every((key, i) => equals(getPath(doc, key), values[i]))
      );
      if (clash) {
        const err = new Error(`E11000 duplicate key error on ${this.name}`);
        err.code = 11000;
        throw err;
      }
    }
  }

  find(query = {}) {
    return new Cursor(this.docs.filter((doc) => matches(doc, query)));
  }

  async findOne(query = {}, options = {}) {
    const cursor = this.find(query);
    if (options.projection) cursor.project(options.projection);
    if (options.sort) cursor.sort(options.sort);
    const [first] = await cursor.limit(1).toArray();
    return first || null;
  }

  async insertOne(doc) {
    const withId = { _id: doc._id || new ObjectId(), ...clone(doc) };
    this.assertUnique(withId);
    this.docs.push(withId);
    return { insertedId: withId._id, acknowledged: true };
  }

  async insertMany(docs) {
    const ids = [];
    for (const doc of docs) ids.push((await this.insertOne(doc)).insertedId);
    return { insertedIds: ids, insertedCount: ids.length };
  }

  async updateOne(query, update, options = {}) {
    const index = this.docs.findIndex((doc) => matches(doc, query));
    if (index === -1) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const seed = Object.fromEntries(
        Object.entries(query).filter(([, v]) => typeof v !== "object" || v instanceof ObjectId || v instanceof Date)
      );
      const created = applyUpdate(seed, update);
      this.assertUnique(created);
      this.docs.push({ _id: created._id || new ObjectId(), ...created });
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    const next = applyUpdate(this.docs[index], update);
    this.assertUnique(next, this.docs[index]._id);
    this.docs[index] = next;
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(query, update) {
    let count = 0;
    for (let i = 0; i < this.docs.length; i += 1) {
      if (matches(this.docs[i], query)) {
        this.docs[i] = applyUpdate(this.docs[i], update);
        count += 1;
      }
    }
    return { matchedCount: count, modifiedCount: count };
  }

  async findOneAndUpdate(query, update, options = {}) {
    const index = this.docs.findIndex((doc) => matches(doc, query));
    if (index === -1) {
      if (!options.upsert) return null;
      await this.updateOne(query, update, { upsert: true });
      return clone(this.docs[this.docs.length - 1]);
    }
    const before = clone(this.docs[index]);
    const next = applyUpdate(this.docs[index], update);
    this.assertUnique(next, before._id);
    this.docs[index] = next;
    return options.returnDocument === "after" ? clone(next) : before;
  }

  async deleteOne(query) {
    const index = this.docs.findIndex((doc) => matches(doc, query));
    if (index === -1) return { deletedCount: 0 };
    this.docs.splice(index, 1);
    return { deletedCount: 1 };
  }

  async deleteMany(query = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matches(doc, query));
    return { deletedCount: before - this.docs.length };
  }

  async countDocuments(query = {}) {
    return this.docs.filter((doc) => matches(doc, query)).length;
  }

  async distinct(field, query = {}) {
    const values = this.docs.filter((doc) => matches(doc, query)).map((doc) => getPath(doc, field));
    return [...new Set(values.map((v) => (v instanceof ObjectId ? v.toHexString() : v)))];
  }
}

class MemoryDb {
  constructor() {
    this.collections = new Map();
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection(name));
    return this.collections.get(name);
  }
  reset() {
    this.collections.clear();
  }
}

module.exports = { MemoryDb, MemoryCollection, matches, applyUpdate, compare };

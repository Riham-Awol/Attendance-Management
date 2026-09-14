"use strict";

const { MongoClient } = require("mongodb");
const env = require("./env");

let client;
let db;

const COLLECTIONS = {
  users: "users",
  attendance: "attendance",
  leaves: "leaves",
  offices: "offices",
  shifts: "shifts",
  holidays: "holidays",
  settings: "settings",
  auditLogs: "auditLogs",
};

async function connect(uri = env.mongoUri, dbName = env.dbName) {
  if (db) return db;
  client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes(db);
  return db;
}

function getDb() {
  if (!db) throw new Error("Database not connected. Call connect() first.");
  return db;
}

const collection = (name) => getDb().collection(name);

async function ensureIndexes(database) {
  await Promise.all([
    database.collection(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true }),
    database.collection(COLLECTIONS.users).createIndex({ employeeCode: 1 }, { unique: true, sparse: true }),
    database.collection(COLLECTIONS.users).createIndex({ department: 1, status: 1 }),
    // One attendance row per person per shift-day: this unique index is what
    // stops a double-tap on Check In from creating two records.
    database.collection(COLLECTIONS.attendance).createIndex({ userId: 1, date: 1 }, { unique: true }),
    database.collection(COLLECTIONS.attendance).createIndex({ date: 1, status: 1 }),
    database.collection(COLLECTIONS.leaves).createIndex({ userId: 1, fromDate: 1 }),
    database.collection(COLLECTIONS.leaves).createIndex({ status: 1, fromDate: 1 }),
    database.collection(COLLECTIONS.holidays).createIndex({ date: 1 }, { unique: true }),
    database.collection(COLLECTIONS.auditLogs).createIndex({ at: -1 }),
    database.collection(COLLECTIONS.auditLogs).createIndex({ targetType: 1, targetId: 1 }),
  ]);
}

/**
 * Inject a database instance for tests. The sandbox has no mongod binary, so
 * the service tests run against an in-memory stand-in (see
 * tests/helpers/memory-mongo.js) wired in through here.
 */
function __setDbForTests(instance) {
  db = instance;
}

async function close() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

module.exports = { connect, getDb, close, collection, COLLECTIONS, ensureIndexes, __setDbForTests };

"use strict";

/**
 * Turn a MongoDB driver error into something the person deploying can act on.
 *
 * The driver's own messages name a failure mode but not a remedy, and the
 * three common first-deployment mistakes — wrong password, closed IP
 * allowlist, malformed URI — look similar from the browser. Each gets its own
 * hint here.
 */

// A connection string carries the password. It must never reach a response
// body, a log line, or a browser console.
const CREDENTIALS = /(mongodb(?:\+srv)?:\/\/)[^@/\s]*@/gi;

const redact = (text) => String(text ?? "").replace(CREDENTIALS, "$1<credentials>@");

const HINTS = [
  {
    // Reached before the generic "cannot connect" hint: this one is not about
    // the database's settings at all.
    match: (err) => /127\.0\.0\.1|localhost/.test(String(err.message)),
    hint:
      "The app tried to reach a database on its own machine, which on a hosted deployment means MONGO_URI is not set for this environment. Set it, then redeploy — environment variables only reach a new deployment.",
  },
  {
    match: (err) => /querySrv|ENOTFOUND|getaddrinfo/i.test(String(err.message)),
    hint:
      "The cluster hostname in MONGO_URI could not be resolved. Copy the connection string again from Atlas (Connect → Drivers), and keep the mongodb+srv:// prefix.",
  },
  {
    match: (err) => /bad auth|authentication failed|AuthenticationFailed/i.test(err.message || ""),
    hint:
      "MongoDB rejected the username or password in MONGO_URI. If the password contains @ : / ? # or %, each must be percent-encoded.",
  },
  {
    match: (err) => err.name === "MongoParseError" || /Invalid scheme|URI must/i.test(err.message || ""),
    hint:
      "MONGO_URI is not a valid connection string. It should start with mongodb+srv:// for Atlas, and the <password> placeholder must be replaced.",
  },
  {
    match: (err) => err.name === "MongoServerSelectionError" || /ServerSelection|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(String(err)),
    hint:
      "The database refused or ignored the connection. On Atlas this is almost always Network Access: a serverless host has no fixed IP, so it needs 0.0.0.0/0 on the allowlist.",
  },
];

function describeDatabaseError(err) {
  const known = HINTS.find((candidate) => candidate.match(err));
  return {
    message: "The server is running but could not reach its database.",
    detail: `${err.name || "Error"}: ${redact(err.message)}`,
    hint: known
      ? known.hint
      : "Check MONGO_URI, and that the database accepts connections from this deployment.",
  };
}

module.exports = { describeDatabaseError, redact };

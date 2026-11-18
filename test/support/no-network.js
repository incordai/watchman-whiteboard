"use strict";

// Watchman Whiteboard: a test file that requires this cannot reach the network. Every way a library could
// call out (fetch, http, https, net, tls) throws and is recorded, so a test can say that a library loaded and
// worked offline. Only for test files that start no server of their own: local connections fail too.

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const attempts = [];

// @purity non-pure
function refuse(what) {
  return (...args) => {
    const target = args[0] && typeof args[0] === "object" ? args[0].href || args[0].host || args[0].hostname : args[0];
    attempts.push(`${what} ${String(target)}`);
    throw new Error(`network is blocked in this test (${what})`);
  };
}

globalThis.fetch = async (...args) => refuse("fetch")(...args);
http.request = refuse("http.request");
http.get = refuse("http.get");
https.request = refuse("https.request");
https.get = refuse("https.get");
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
tls.connect = refuse("tls.connect");

module.exports = { attempts };

"use strict"
// DOC: ../../docs/quirks.md → § waf-headers

// Quirk: waf-headers
//
// agentrouter.org sits behind an Aliyun WAF that rejects unrecognised clients
// with HTTP 401 {"type":"unauthorized_client_error"} before the request ever
// reaches the gateway.
//
// Phase 0 bisection established the gate is exactly two headers, and nothing
// else. Dropping any single other header still returned 200; dropping either of
// these returned 401:
//
//   user-agent:        must match /^Anthropic\/Python/ — case-sensitive.
//                      "anthropic/python 1.2.0" is blocked, version is ignored.
//   x-stainless-lang:  must be literally "python". "js", "node", "go", "" all blocked.
//
// Note this contradicts the comment in the old agentrouter-proxy/proxy.py, which
// blamed TLS fingerprinting. Proof it is headers, not TLS: raw httpx requests
// issued through the *same sync client's socket pool* that the Anthropic SDK
// used got 401, while the SDK's own calls got 200. Identical TLS stack, only the
// headers differed. That is why Cupbearer needs no Python sidecar.

module.exports = {
  id: "waf-headers",
  description:
    "Sends the two client-identity headers agentrouter's WAF requires (user-agent: Anthropic/Python, x-stainless-lang: python). Without them every request 401s regardless of key validity.",

  transformHeaders(headers) {
    headers["user-agent"] = "Anthropic/Python 1.2.0"
    headers["x-stainless-lang"] = "python"
    return headers
  },
}

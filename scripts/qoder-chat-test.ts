import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const COSY_VERSION = "0.1.43";
const APPCODE = "cosy";
const SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const S2C = new Array(128).fill(-1);
for (let i = 0; i < 64; i++) S2C[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
S2C["=".charCodeAt(0)] = "$".charCodeAt(0);

const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function encodePayload(data: string): string {
  const std = Buffer.from(data, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.substring(n - a) + std.substring(a, n - a) + std.substring(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged.charCodeAt(i);
    out += String.fromCharCode(S2C[c]);
  }
  return out;
}

function md5Hex(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

const tokens = {
  personalToken: "pt-QNhvz41dtFS1B5jmZv7Tpcad_019e71f2-ee5c-7aac-8c36-80de94a70e35",
  securityOauthToken: "jt-DZJMCqOVS3jUVlVfkxft8LfQ",
  refreshToken: "jrt-9tbNK3tqeVVcDNuQFu7mFVzB",
  userId: "019e71f2-cbb7-7233-8d00-11d1b43d32f9",
  userName: "IndiraSakaKrisnanda ulle",
  userType: "personal_standard",
  machineId: "55a3630d-404a-487e-842b-03af9b8302dc",
  machineToken: Buffer.from(crypto.randomUUID().replace(/-/g, "").slice(0, 50), "ascii").toString("base64url"),
  machineType: crypto.randomUUID().replace(/-/g, "").slice(0, 18),
};

async function testChat() {
  const CHAT_URL = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

  // Load baseprompt
  let raw = fs.readFileSync(path.resolve(import.meta.dir, "../src/proxy/providers/qoder-baseprompt.json"), "utf8");
  raw = raw.replace(/\{UUID[1-5]\}/g, () => crypto.randomUUID());
  raw = raw.replace(/\{TIME1\}/g, String(Date.now()));
  const template = JSON.parse(raw);
  template.llm_model = "lite";
  template.messages = [{ role: "user", content: "hi" }];

  const bodyEncoded = encodePayload(JSON.stringify(template));

  // Build COSY bearer
  const tempKey = Buffer.from(crypto.randomUUID().replace(/-/g, "").slice(0, 16), "ascii");
  const cosyKey = crypto.publicEncrypt(
    { key: SERVER_PUBKEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    tempKey,
  ).toString("base64");

  const identity = JSON.stringify({
    name: tokens.userName, aid: tokens.userId, uid: tokens.userId,
    yx_uid: "", organization_id: "", organization_name: "",
    user_type: tokens.userType,
    security_oauth_token: tokens.securityOauthToken,
    refresh_token: tokens.refreshToken,
  });
  const cipher = crypto.createCipheriv("aes-128-cbc", tempKey, tempKey);
  const info = Buffer.concat([cipher.update(Buffer.from(identity)), cipher.final()]).toString("base64");

  const payloadB64 = Buffer.from(JSON.stringify({
    cosyVersion: COSY_VERSION, ideVersion: "", info, requestId: crypto.randomUUID(), version: "v1",
  })).toString("base64");

  const date = String(Math.floor(Date.now() / 1000));
  const pathSig = "/api/v2/service/pro/sse/agent_chat_generation";
  const sig = md5Hex(`${payloadB64}\n${cosyKey}\n${date}\n${bodyEncoded}\n${pathSig}`);

  const headers: Record<string, string> = {
    "cosy-data-policy": "AGREE",
    "content-type": "application/json",
    "cosy-machinetype": tokens.machineType,
    "cosy-clienttype": "5",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": tokens.machineId,
    "cosy-key": cosyKey,
    "cosy-date": date,
    "cosy-signature": sig,
    authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "user-agent": "Go-http-client/2.0",
  };

  console.log("Sending chat request...");
  const resp = await fetch(CHAT_URL, { method: "POST", headers, body: bodyEncoded });
  console.log(`Status: ${resp.status}`);
  console.log("Response headers:");
  resp.headers.forEach((v, k) => {
    // Look for anything quota/limit/remaining related
    if (k.toLowerCase().includes("limit") || k.toLowerCase().includes("quota") || 
        k.toLowerCase().includes("remaining") || k.toLowerCase().includes("rate") ||
        k.toLowerCase().includes("x-") || k.toLowerCase().includes("retry")) {
      console.log(`  ${k}: ${v}`);
    }
  });
  // Print ALL headers to see what's there
  console.log("\nAll headers:");
  resp.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));

  if (resp.status !== 200) {
    const text = await resp.text();
    console.log("\nBody:", text.slice(0, 500));
    return;
  }

  // Stream and look for quota info in SSE
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let fullOutput = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullOutput += decoder.decode(value, { stream: true });
      if (fullOutput.length > 2000) break;
    }
  } catch (e: any) {
    console.log(`\nStream ended: ${e.message}`);
  }
  console.log("\nSSE output (first 2000 chars):");
  console.log(fullOutput.slice(0, 2000));
}

testChat();

import { bearerFetch, encodeQoderPayload } from "../src/proxy/providers/qoder";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// Fresh tokens from jobToken refresh
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

// Load baseprompt template
const baseprompt = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src/proxy/providers/qoder-baseprompt.json"), "utf8"));

async function probe() {
  const CHAT_URL = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

  // Minimal chat body
  const body = {
    ...baseprompt,
    llm_model: "lite",
    messages: [
      { role: "user", content: "Say hi in one word" }
    ],
  };

  try {
    const resp = await bearerFetch(tokens, { url: CHAT_URL, body, stream: true });
    console.log(`\n=== chat (lite model) === [${resp.status}]`);
    
    if (!resp.ok) {
      const text = await resp.text();
      console.log(text.slice(0, 500));
      return;
    }

    // Read first few chunks of SSE
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let chunks = 0;
    while (chunks < 20) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      chunks++;
    }
    reader.releaseLock();
    console.log(output.slice(0, 1000));
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
  }
}

probe();

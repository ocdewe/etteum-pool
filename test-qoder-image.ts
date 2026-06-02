// Test script to verify Qoder image handling
const testData = {
  model: "qd-Qwen3.7-Max",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "gambar apa ini?" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
          }
        }
      ]
    }
  ],
  stream: false
};

console.log("Sending test request to proxy...");
console.log("Model:", testData.model);
console.log("Messages:", JSON.stringify(testData.messages, null, 2));

fetch("http://localhost:1630/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer pool-proxy-secret-key"
  },
  body: JSON.stringify(testData)
})
  .then(r => r.text())
  .then(body => {
    console.log("\n=== Response ===");
    console.log(body);
  })
  .catch(err => {
    console.error("\n=== Error ===");
    console.error(err);
  });

import http from "node:http";
import { greet } from "./lib.js";

const port = Number(process.env.APP_PORT ?? 9999);
http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: greet("world"), mode: process.env.GREETING_API_KEY ? "live" : "demo" }));
  })
  .listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));

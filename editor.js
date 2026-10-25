"use strict";

// Node.js 18+ backend for Neelakanta Edits. Keep this beside index.html.
// Set OWNER_TOKEN to a private random value before starting the server.

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const OWNER_TOKEN = process.env.OWNER_TOKEN || "";
const DATA_DIRECTORY = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIRECTORY, "orders.json");
const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_ORDERS_PER_WINDOW = 10;
const requestCounts = new Map();

if (OWNER_TOKEN.length < 32) {
  console.error("Set OWNER_TOKEN to a private random value of at least 32 characters.");
  process.exit(1);
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(JSON.stringify(data));
}

function isOwner(request) {
  const authorization = request.headers.authorization || "";
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) return false;

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(OWNER_TOKEN);
  return provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });

    request.on("error", reject);
  });
}

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateOrder(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Invalid order." };
  }

  const order = {
    name: text(input.name, 100),
    phone: text(input.phone, 30),
    email: text(input.email, 150),
    service: text(input.service, 100),
    deadline: text(input.deadline, 10),
    budget: text(input.budget, 60),
    details: text(input.details, 2500),
    delivery: text(input.delivery, 80),
    payment: text(input.payment, 100)
  };

  if (!order.name || !order.phone || !order.service || !order.details) {
    return { error: "Name, phone, service, and project details are required." };
  }

  const phoneDigits = order.phone.replace(/\D/g, "");
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    return { error: "Enter a valid phone number." };
  }

  if (order.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email)) {
    return { error: "Enter a valid email address." };
  }

  if (order.deadline) {
    const parsedDate = new Date(`${order.deadline}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(order.deadline) ||
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== order.deadline) {
      return { error: "Enter a valid deadline." };
    }
  }

  return { order };
}

async function readOrders() {
  try {
    const contents = await fs.readFile(ORDERS_FILE, "utf8");
    const orders = JSON.parse(contents);
    if (!Array.isArray(orders)) throw new Error("Orders file must contain a JSON array.");
    return orders;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

let writeQueue = Promise.resolve();

function updateOrders(mutator) {
  const operation = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIRECTORY, { recursive: true });
    const orders = await readOrders();
    const result = await mutator(orders);
    const temporaryFile = `${ORDERS_FILE}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(orders, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryFile, ORDERS_FILE);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function isRateLimited(request) {
  const now = Date.now();
  const address = request.socket.remoteAddress || "unknown";
  const current = requestCounts.get(address);

  if (!current || now - current.start >= RATE_WINDOW_MS) {
    requestCounts.set(address, { start: now, count: 1 });
    return false;
  }

  current.count += 1;
  return current.count > MAX_ORDERS_PER_WINDOW;
}

function serveWebsite(response) {
  fs.readFile(path.join(__dirname, "index.html")).then((html) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY"
    });
    response.end(html);
  }).catch((error) => {
    console.error("Could not read index.html:", error.message);
    sendJson(response, 500, { error: "Website file could not be loaded." });
  });
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    serveWebsite(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/orders") {
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendJson(response, 415, { error: "Send order data as JSON." });
      return;
    }
    if (isRateLimited(request)) {
      sendJson(response, 429, { error: "Too many orders from this connection. Please try again later." });
      return;
    }

    const input = await readJson(request);
    const validation = validateOrder(input);
    if (validation.error) {
      sendJson(response, 400, { error: validation.error });
      return;
    }

    const saved = await updateOrders((orders) => {
      const order = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: "New",
        ...validation.order
      };
      orders.push(order);
      return order;
    });
    sendJson(response, 201, { message: "Order received.", order: saved });
    return;
  }

  if (url.pathname.startsWith("/api/orders")) {
    if (!isOwner(request)) {
      sendJson(response, 401, { error: "Owner authorization required." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/orders") {
      const orders = await readOrders();
      orders.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
      sendJson(response, 200, { orders });
      return;
    }

    const match = /^\/api\/orders\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (!match) {
      sendJson(response, 404, { error: "Order not found." });
      return;
    }
    const orderId = match[1];

    if (request.method === "PATCH") {
      const body = await readJson(request);
      const allowedStatuses = ["New", "Contacted", "In progress", "Completed", "Cancelled"];
      if (!body || !allowedStatuses.includes(body.status)) {
        sendJson(response, 400, { error: "Invalid order status." });
        return;
      }
      const updated = await updateOrders((orders) => {
        const order = orders.find((entry) => entry.id === orderId);
        if (order) order.status = body.status;
        return order || null;
      });
      if (!updated) {
        sendJson(response, 404, { error: "Order not found." });
        return;
      }
      sendJson(response, 200, { order: updated });
      return;
    }

    if (request.method === "DELETE") {
      const deleted = await updateOrders((orders) => {
        const index = orders.findIndex((entry) => entry.id === orderId);
        if (index < 0) return false;
        orders.splice(index, 1);
        return true;
      });
      if (!deleted) {
        sendJson(response, 404, { error: "Order not found." });
        return;
      }
      sendJson(response, 200, { message: "Order deleted." });
      return;
    }
  }

  sendJson(response, 404, { error: "Not found." });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Request failed:", error.message);
    if (!response.headersSent) {
      sendJson(response, error.status || 500, {
        error: error.status ? error.message : "Server error. Please try again."
      });
    } else {
      response.destroy();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Neelakanta Edits is running at http://localhost:${PORT}`);
  console.log("Orders are stored in data/orders.json");
});

import bodyParser from "body-parser";
import express from "express";
import http from "http";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";
import { NodeState } from "../types";


const messageBuffer: { [round: number]: (0 | 1)[] } = {};

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  let state: NodeState = {
    killed: false,
    x: initialValue,
    decided: false,
    k: 0,
  };

  if (isFaulty) {
    state = {
      killed: false,
      x: null,
      decided: null,
      k: null,
    };
  }

  node.get("/status", (req, res) => {
    if (isFaulty) {
      res.status(500).send("faulty");
    } else {
      res.status(200).send("live");
    }
  });

  node.get("/getState", (req, res) => {
    res.json({
      killed: state.killed,
      x: state.x !== undefined ? state.x : null,
      decided: state.decided === true ? true : (state.decided === false ? false : null),
      k: state.k !== undefined ? state.k : null,
    });
  });


  node.get("/start", async (req, res) => {
    if (state.killed) {
      res.status(400).send("Node is stopped");
      return;
    }
    await waitForAllNodes();
    startConsensus();
    res.status(200).send("Consensus algorithm started");
  });

  // Route to stop the consensus algorithm
  node.get("/stop", async (req, res) => {
    state.killed = true;
    state.x = null;
    state.decided = null;
    state.k = null;
    res.status(200).send("Node stopped");
  });

  node.post("/message", (req, res) => {
    if (state.killed || isFaulty) {
      res.status(400).send("Node is stopped or faulty");
      return;
    }

    const message = req.body;
    if (message.value === 0 || message.value === 1) {
      if (!messageBuffer[state.k!]) messageBuffer[state.k!] = [];
      messageBuffer[state.k!].push(message.value);
    }

    res.status(200).send("Message received");
  });

  async function waitForAllNodes() {
    while (!nodesAreReady()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function startConsensus() {
    if (isFaulty) return;

    while (!state.decided && !state.killed && (state.k ?? 0) < 50) {
      await broadcastValue();
      await waitForAllNodes();
      const values = await collectValues();
      const majorityValue = getMajorityValue(values);

      if (majorityValue !== null) {
        state.x = majorityValue;
        state.decided = true;
      } else {
        state.x = getSimpleMajority(values);
      }
      state.k = (state.k ?? 0) + 1;
    }
  }


  function broadcastValue() {
    for (let i = 0; i < N; i++) {
      if (i !== nodeId) {
        sendMessage(i, { from: nodeId, value: state.x });
      }
    }
  }

  function collectValues(): Promise<(0 | 1)[]> {
    return new Promise((resolve) => {
      if (N === 1) {
        resolve([state.x as 0 | 1]);
        return;
      }
      const checkBuffer = () => {
        const messages = messageBuffer[state.k!];
        if (messages && messages.length >= N - 1 - F) {
          resolve(messages);
        } else {
          setTimeout(checkBuffer, 50);
        }
      };
      checkBuffer();
    });
  }


  function getMajorityValue(values: (0 | 1)[]): 0 | 1 | null {
    const count0 = values.filter((v) => v === 0).length;
    const count1 = values.filter((v) => v === 1).length;
    if (F === 0) {
      if (count0 > count1 && count0 > values.length / 2) return 0;
      if (count1 >= count0 && count1 > values.length / 2) return 1;
      return null;
    }
    if (count0 >= (2 * F + 1)) return 0;
    if (count1 >= (2 * F + 1)) return 1;

    return null;
  }

  function getSimpleMajority(values: (0 | 1)[]): 0 | 1 {
    const count0 = values.filter((v) => v === 0).length;
    const count1 = values.filter((v) => v === 1).length;
    return count1 >= count0 ? 1 : 0;

  }

  function sendMessage(targetNodeId: number, message: any) {
    const options = {
      hostname: "localhost",
      port: BASE_NODE_PORT + targetNodeId,
      path: "/message",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = http.request(options, (res) => {
      res.on("data", () => {});
    });

    req.on("error", (error) => {
      console.error(`Error sending message to node ${targetNodeId}:`, error);
    });

    req.write(JSON.stringify(message));
    req.end();
  }

  function getStateFromNode(targetNodeId: number, callback: (value: 0 | 1 | null) => void) {
    const options = {
      hostname: "localhost",
      port: BASE_NODE_PORT + targetNodeId,
      path: "/getState",
      method: "GET",
    };

    const req = http.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const state = JSON.parse(data);
          callback(state.x);
        } catch (error) {
          console.error(`Error parsing state from node ${targetNodeId}:`, error);
          callback(null);
        }
      });
    });

    req.on("error", (error) => {
      callback(null);
    });

    req.end();
  }


  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    setNodeIsReady(nodeId);
  });

  return server;
}

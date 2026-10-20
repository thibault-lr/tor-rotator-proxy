import { request as connect, type ClientRequest } from "node:http";
import { Agent, request } from "node:https";
import { isIP, type Socket } from "node:net";
import { connect as secure, type TLSSocket } from "node:tls";

export type IpResult = {
  ip: string | null;
  status_code: number | null;
  error: string | null;
};

export async function probeIp(
  proxy: string,
  cancellation?: AbortSignal,
): Promise<IpResult> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = cancellation
    ? AbortSignal.any([deadline, cancellation])
    : deadline;
  const agent = new Agent();
  let tunnel: ClientRequest | undefined;
  let socket: Socket | undefined;
  let tlsSocket: TLSSocket | undefined;
  let status: number | null = null;
  let failure = "invalid_proxy";
  try {
    const address = new URL(proxy);
    if (
      address.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(address.hostname) ||
      address.username ||
      address.password ||
      address.pathname !== "/" ||
      address.search ||
      address.hash ||
      address.port === "0"
    ) {
      throw new Error("Expected a loopback HTTP proxy");
    }
    failure = "connect_error";
    socket = await new Promise<Socket>((resolve, reject) => {
      tunnel = connect(address, {
        method: "CONNECT",
        path: "check.torproject.org:443",
        headers: { Host: "check.torproject.org:443" },
        agent: false,
        signal,
      });
      tunnel.once("error", reject);
      tunnel.once("response", (response) => {
        status = response.statusCode ?? null;
        failure = `http_${status ?? "invalid"}`;
        response.destroy();
        reject(new Error(failure));
      });
      tunnel.once("connect", (response, connected, head) => {
        socket = connected;
        if (response.statusCode !== 200) {
          status = response.statusCode ?? null;
          failure = `http_${status ?? "invalid"}`;
          reject(new Error(failure));
        } else {
          if (head.length) {
            connected.unshift(head);
          }
          resolve(connected);
        }
      });
      tunnel.end();
    });
    failure = "tls_error";
    agent.createConnection = () => {
      tlsSocket = secure({ socket, servername: "check.torproject.org" });
      tlsSocket.once("secureConnect", () => {
        failure = "http_error";
      });
      return tlsSocket;
    };
    const ip = await new Promise<string>((resolve, reject) => {
      const outgoing = request(
        "https://check.torproject.org/api/ip",
        { agent, signal },
        (response) => {
          status = response.statusCode ?? null;
          if (status !== 200) {
            failure = `http_${status ?? "invalid"}`;
            response.destroy();
            reject(new Error(failure));
            return;
          }
          failure = "invalid_response";
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 1_024) {
              outgoing.destroy(new Error("Response too large"));
            }
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const value = JSON.parse(body);
              if (
                value.IsTor !== true ||
                typeof value.IP !== "string" ||
                !isIP(value.IP)
              ) {
                throw new Error("Invalid Tor IP response");
              }
              resolve(value.IP);
            } catch {
              reject(new Error("Invalid Tor IP response"));
            }
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
    return { ip, status_code: status, error: null };
  } catch {
    return {
      ip: null,
      status_code: status,
      error: cancellation?.aborted
        ? "cancelled"
        : deadline.aborted
          ? "timeout"
          : failure,
    };
  } finally {
    agent.destroy();
    tlsSocket?.destroy();
    socket?.destroy();
    tunnel?.destroy();
  }
}

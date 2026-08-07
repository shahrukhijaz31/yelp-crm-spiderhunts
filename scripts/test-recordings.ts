import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * End-to-end check of the call-recording feature, against a running server and
 * a real database.
 *
 *   npm run dev                     (in one terminal)
 *   npm run test:recordings         (in another)
 *
 * Why a script rather than a test runner: this repository has no test
 * framework, and the things worth checking here are not unit-testable in any
 * useful sense. "An agent cannot reach another agent's recording" is a claim
 * about a session cookie, a route handler and two Postgres rows; a mocked
 * version of it would pass whether or not the real thing works. So this signs
 * in over HTTP exactly as a browser does, and asks the API the awkward
 * questions.
 *
 * It creates its own throwaway users (`rectest-*`) and deletes them, along with
 * every recording it uploads, on the way out — including after a failure. It
 * never touches an existing user or an existing recording.
 *
 * The one thing it cannot cover is the upload progress bar, which is a browser
 * API (`XMLHttpRequest.upload.onprogress`) with no server side to observe.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "recording-test-Pa55phrase";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  log: ["error"],
});

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A signed-in browser: one cookie jar, one `fetch`. */
class Client {
  private cookie = "";

  constructor(readonly label: string) {}

  async signIn(identifier: string): Promise<void> {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: identifier, password: PASSWORD }),
    });
    if (!response.ok) {
      throw new Error(`${this.label} could not sign in: ${response.status} ${await response.text()}`);
    }
    const setCookie = response.headers.get("set-cookie") ?? "";
    this.cookie = setCookie.split(";")[0] ?? "";
    if (!this.cookie) throw new Error(`${this.label} got no session cookie`);
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    return fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: "manual" });
  }
}

/**
 * A real, playable WAV: 16-bit mono PCM, a 440Hz tone. Genuinely decodable
 * audio rather than a header with padding behind it, so a browser pointed at
 * the result of this test actually plays something.
 */
function makeWav(seconds: number): Uint8Array {
  const rate = 8000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM header size
  buffer.writeUInt16LE(1, 20); // format: PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);

  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 8000), 44 + i * 2);
  }

  return new Uint8Array(buffer);
}

/** An MP3 as far as the sniffer is concerned: an ID3v2 tag and a payload. */
function makeMp3(bytes: number): Uint8Array {
  const buffer = Buffer.alloc(bytes);
  buffer.write("ID3\x03\x00\x00\x00\x00\x00\x00", 0, "latin1");
  return new Uint8Array(buffer);
}

function upload(
  client: Client,
  leadId: string,
  file: { name: string; type: string; bytes: Uint8Array },
  durationSeconds?: number,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([file.bytes as BlobPart], file.name, { type: file.type }));
  if (durationSeconds !== undefined) form.append("durationSeconds", String(durationSeconds));
  return client.fetch(`/api/meetings/${leadId}/recording`, { method: "POST", body: form });
}

async function main(): Promise<void> {
  console.log(`\nCall recordings — end-to-end against ${BASE_URL}\n`);

  // --- Fixtures ------------------------------------------------------------

  const passwordHash = await hashPassword(PASSWORD);
  const suffix = randomBytes(4).toString("hex");
  const names = {
    agent: `rectest-agent-${suffix}`,
    other: `rectest-other-${suffix}`,
    admin: `rectest-admin-${suffix}`,
  };

  const users = await Promise.all(
    (
      [
        [names.agent, "AGENT"],
        [names.other, "AGENT"],
        [names.admin, "ADMIN"],
      ] as const
    ).map(([username, role]) =>
      prisma.user.create({
        data: {
          username,
          email: `${username}@example.test`,
          name: `Recording test ${role.toLowerCase()}`,
          passwordHash,
          role,
        },
      }),
    ),
  );

  // A lead that is on the agenda, and one that is not — the second is what
  // proves the endpoint refuses recordings against arbitrary lead ids.
  const meetingLead =
    (await prisma.lead.findFirst({
      where: { OR: [{ status: "interested" }, { callbackDate: { not: null } }] },
    })) ??
    (await prisma.lead.findFirst().then((lead) =>
      lead ? prisma.lead.update({ where: { id: lead.id }, data: { status: "interested" } }) : null,
    ));

  const plainLead = await prisma.lead.findFirst({
    where: { status: "not_called", callbackDate: null, id: { not: meetingLead?.id } },
  });

  if (!meetingLead) throw new Error("No leads in the database — import a CSV first.");

  // Put the test meeting in today's bucket, which is the tab the Meetings page
  // opens on, so the rendered HTML can be checked for the recording row rather
  // than only the API being asked about it. Restored in `finally`.
  const originalCallbackDate = meetingLead.callbackDate;
  const today = new Date();
  await prisma.lead.update({
    where: { id: meetingLead.id },
    data: {
      callbackDate: new Date(
        Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
      ),
    },
  });

  const agent = new Client("agent");
  const other = new Client("other agent");
  const admin = new Client("admin");
  const anonymous = new Client("signed out");

  await agent.signIn(names.agent);
  await other.signIn(names.other);
  await admin.signIn(names.admin);

  const url = `/api/meetings/${meetingLead.id}/recording`;
  const wav = makeWav(2);

  try {
    // --- 1. An agent uploads valid audio ----------------------------------
    const uploaded = await upload(agent, meetingLead.id, {
      name: "call-with-client.wav",
      type: "audio/wav",
      bytes: wav,
    }, 2);
    const uploadedBody = await uploaded.json().catch(() => ({}));
    check(
      "1. agent uploads valid audio",
      uploaded.status === 201 && uploadedBody.recording?.fileType === "audio/wav",
      `${uploaded.status} ${JSON.stringify(uploadedBody).slice(0, 160)}`,
    );
    check(
      "1b. metadata records who uploaded it",
      uploadedBody.recording?.uploadedBy?.id === users[0].id &&
        uploadedBody.recording?.fileSize === wav.byteLength,
    );

    // --- 2. Invalid file type is rejected ---------------------------------
    const textFile = await upload(agent, meetingLead.id, {
      name: "notes.txt",
      type: "text/plain",
      bytes: new Uint8Array(Buffer.alloc(2048, "hello world ")),
    });
    check("2. plain text is rejected", textFile.status === 415, `got ${textFile.status}`);

    // The interesting half: a non-audio file wearing an audio name and type.
    // Only the magic-byte sniff catches this one.
    const disguised = await upload(agent, meetingLead.id, {
      name: "call.mp3",
      type: "audio/mpeg",
      bytes: new Uint8Array(Buffer.from("<html><script>alert(1)</script></html>".padEnd(2048, " "))),
    });
    check(
      "2b. HTML disguised as .mp3 is rejected",
      disguised.status === 415,
      `got ${disguised.status}`,
    );

    // --- 3. Oversized file is rejected ------------------------------------
    const oversized = await upload(agent, meetingLead.id, {
      name: "long-call.mp3",
      type: "audio/mpeg",
      bytes: makeMp3(26 * 1024 * 1024),
    });
    check("3. oversized file is rejected", oversized.status === 413, `got ${oversized.status}`);

    // --- 5. The recording is attached to the meeting ----------------------
    const metadata = await agent.fetch(url);
    const metadataBody = await metadata.json().catch(() => ({}));
    check(
      "5. recording appears on the meeting",
      metadata.ok && metadataBody.recording?.leadId === meetingLead.id,
      `${metadata.status}`,
    );
    check(
      "5b. the storage key never reaches the client",
      !JSON.stringify(metadataBody).includes("storageKey"),
    );
    check(
      "5c. a rejected upload did not replace the good one",
      metadataBody.recording?.fileSize === wav.byteLength,
    );

    // --- 6. The agent can play their own recording ------------------------
    const stream = await agent.fetch(`${url}/stream`);
    const streamed = new Uint8Array(await stream.arrayBuffer());
    check(
      "6. agent streams their own recording",
      stream.status === 200 &&
        stream.headers.get("content-type") === "audio/wav" &&
        streamed.byteLength === wav.byteLength &&
        Buffer.compare(Buffer.from(streamed), Buffer.from(wav)) === 0,
      `${stream.status} ${streamed.byteLength}B`,
    );
    check(
      "6b. served inline, not as a download",
      (stream.headers.get("content-disposition") ?? "").startsWith("inline") &&
        stream.headers.get("x-content-type-options") === "nosniff",
    );
    check(
      "6c. not cacheable by a shared cache",
      (stream.headers.get("cache-control") ?? "").includes("no-store"),
    );

    // Seeking: a range request is what makes the scrubber work.
    const ranged = await agent.fetch(`${url}/stream`, { headers: { range: "bytes=100-199" } });
    const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
    check(
      "6d. range request returns 206 with exactly that slice",
      ranged.status === 206 &&
        rangedBytes.byteLength === 100 &&
        ranged.headers.get("content-range") === `bytes 100-199/${wav.byteLength}` &&
        Buffer.compare(Buffer.from(rangedBytes), Buffer.from(wav.subarray(100, 200))) === 0,
      `${ranged.status} ${rangedBytes.byteLength}B ${ranged.headers.get("content-range")}`,
    );

    const suffixRange = await agent.fetch(`${url}/stream`, { headers: { range: "bytes=-50" } });
    check(
      "6e. suffix range (how a player finds the duration) returns 206",
      suffixRange.status === 206 &&
        suffixRange.headers.get("content-range") === `bytes ${wav.byteLength - 50}-${wav.byteLength - 1}/${wav.byteLength}`,
      `${suffixRange.status} ${suffixRange.headers.get("content-range")}`,
    );

    const pastEnd = await agent.fetch(`${url}/stream`, {
      headers: { range: `bytes=${wav.byteLength + 10}-` },
    });
    check("6f. unsatisfiable range returns 416", pastEnd.status === 416, `got ${pastEnd.status}`);

    // --- 7. The admin can see and play it ---------------------------------
    const adminMeta = await admin.fetch(url);
    const adminBody = await adminMeta.json().catch(() => ({}));
    check(
      "7. admin sees the recording metadata",
      adminMeta.ok && adminBody.recording?.uploadedBy?.name === "Recording test agent",
      `${adminMeta.status}`,
    );
    const adminStream = await admin.fetch(`${url}/stream`);
    check(
      "7b. admin streams an agent's recording",
      adminStream.status === 200 &&
        (await adminStream.arrayBuffer()).byteLength === wav.byteLength,
    );
    check("7c. admin may manage it", adminBody.recording?.canManage === true);

    // --- 8. Another agent cannot reach it ---------------------------------
    const otherMeta = await other.fetch(url);
    check(
      "8. another agent cannot read the metadata",
      otherMeta.status === 404,
      `got ${otherMeta.status}`,
    );
    const otherStream = await other.fetch(`${url}/stream`);
    check(
      "8b. another agent cannot stream the audio",
      otherStream.status === 404,
      `got ${otherStream.status}`,
    );
    const otherDelete = await other.fetch(url, { method: "DELETE" });
    check(
      "8c. another agent cannot delete it",
      otherDelete.status === 404,
      `got ${otherDelete.status}`,
    );
    const otherReplace = await upload(other, meetingLead.id, {
      name: "mine-now.wav",
      type: "audio/wav",
      bytes: makeWav(1),
    });
    check(
      "8d. another agent cannot replace it",
      otherReplace.status === 403,
      `got ${otherReplace.status}`,
    );

    // --- 9. Signed out gets nothing ---------------------------------------
    const anonMeta = await anonymous.fetch(url);
    const anonStream = await anonymous.fetch(`${url}/stream`);
    const anonUpload = await upload(anonymous, meetingLead.id, {
      name: "anon.wav",
      type: "audio/wav",
      bytes: makeWav(1),
    });
    check("9. signed out cannot read metadata", anonMeta.status === 401, `got ${anonMeta.status}`);
    check("9b. signed out cannot stream audio", anonStream.status === 401, `got ${anonStream.status}`);
    check("9c. signed out cannot upload", anonUpload.status === 401, `got ${anonUpload.status}`);

    // --- 11. Replacing works ----------------------------------------------
    const before = await prisma.meetingRecording.findUnique({
      where: { leadId: meetingLead.id },
      select: { storageKey: true },
    });
    const mp3 = makeMp3(4096);
    const replaced = await upload(agent, meetingLead.id, {
      name: "second-call.mp3",
      type: "audio/mpeg",
      bytes: mp3,
    }, 90);
    const replacedBody = await replaced.json().catch(() => ({}));
    const after = await prisma.meetingRecording.findUnique({
      where: { leadId: meetingLead.id },
      select: { storageKey: true },
    });
    check(
      "11. replacing swaps the file and the metadata",
      replaced.status === 201 &&
        replacedBody.recording?.fileType === "audio/mpeg" &&
        replacedBody.recording?.fileName === "second-call.mp3" &&
        replacedBody.recording?.durationSeconds === 90,
      `${replaced.status} ${JSON.stringify(replacedBody).slice(0, 160)}`,
    );
    check(
      "11b. one recording per meeting, on a new storage key",
      before?.storageKey !== undefined &&
        after?.storageKey !== undefined &&
        before.storageKey !== after.storageKey &&
        (await prisma.meetingRecording.count({ where: { leadId: meetingLead.id } })) === 1,
    );
    const replacedStream = await agent.fetch(`${url}/stream`);
    check(
      "11c. the replacement is what streams back",
      replacedStream.headers.get("content-type") === "audio/mpeg" &&
        (await replacedStream.arrayBuffer()).byteLength === mp3.byteLength,
    );

    // --- Not a meeting -----------------------------------------------------
    if (plainLead) {
      const notAMeeting = await upload(agent, plainLead.id, {
        name: "stray.wav",
        type: "audio/wav",
        bytes: makeWav(1),
      });
      check(
        "12a. a lead that is not on the agenda cannot hold a recording",
        notAMeeting.status === 400,
        `got ${notAMeeting.status}`,
      );
    }
    const unknown = await upload(agent, "does-not-exist", {
      name: "stray.wav",
      type: "audio/wav",
      bytes: makeWav(1),
    });
    check("12b. an unknown meeting id is a 404", unknown.status === 404, `got ${unknown.status}`);

    // --- 12. The rest of Meetings still works ------------------------------
    const page = await agent.fetch("/meetings");
    const html = await page.text();
    check("12c. the meetings page still renders", page.status === 200, `got ${page.status}`);
    check(
      "12e. the meeting card shows the recording, server-rendered",
      html.includes("Call recording") &&
        html.includes("Uploaded by") &&
        html.includes("second-call.mp3"),
    );
    check(
      "12f. the agenda itself is unchanged",
      html.includes("Meetings") && html.includes(meetingLead.name),
    );

    const patch = await agent.fetch(`/api/leads/${meetingLead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingNotes: meetingLead.meetingNotes }),
    });
    check("12d. editing a meeting still works", patch.ok, `got ${patch.status}`);

    // --- 10. The admin deletes it -----------------------------------------
    const deleted = await admin.fetch(url, { method: "DELETE" });
    check("10. admin deletes the recording", deleted.ok, `got ${deleted.status}`);
    const afterDelete = await agent.fetch(url);
    check(
      "10b. it is gone for everyone afterwards",
      afterDelete.status === 404 &&
        (await prisma.meetingRecording.count({ where: { leadId: meetingLead.id } })) === 0,
    );
    const afterDeleteStream = await admin.fetch(`${url}/stream`);
    check("10c. and the audio is unreachable", afterDeleteStream.status === 404);
  } finally {
    // Leave the database exactly as it was found, pass or fail.
    await prisma.lead
      .update({
        where: { id: meetingLead.id },
        data: { callbackDate: originalCallbackDate },
      })
      .catch(() => {});
    await prisma.meetingRecording.deleteMany({
      where: { uploadedById: { in: users.map((user) => user.id) } },
    });
    await prisma.session.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await prisma.$disconnect();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("\nTest run failed:", error);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});

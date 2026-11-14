// The Worker that vitest.config.ts puts between the Worker under test and
// the network. Every outbound request and TCP connection ends here. Plain
// JavaScript, because the test runtime loads it as it is.
export default {
  fetch(request) {
    return new Response(`Blocked outbound request to ${request.url}`, {
      status: 502,
    });
  },

  // Answers in place of the host, so that a test can tell a connection that
  // was blocked here from one that failed on its own.
  async connect(socket) {
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode("Blocked outbound connection"));
    await writer.close();
  },
};

// Copyright (C) 2013, Georges-Etienne Legendre <legege@legege.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

const url = require("url");
const http = require("http");

const debugClient = require("debug")("mjpeg-proxy:client");
const debugMjpeg = require("debug")("mjpeg-proxy:mjpeg");

const extractBoundary = (contentType) => {
  const startIndex = contentType.indexOf("boundary=");
  let endIndex = contentType.indexOf(";", startIndex);
  if (endIndex === -1) {
    // boundary is the last option
    // some servers, like mjpeg-streamer puts a '\r' character at the end of each line.
    endIndex = contentType.indexOf("\r", startIndex);
    if (endIndex === -1) {
      endIndex = contentType.length;
    }
  }
  return contentType
    .substring(startIndex + 9, endIndex)
    .replace(/"/gi, "")
    .replace(/^--/gi, "");
};

const MjpegProxy = (options) => {
  this.options = options || {};
  if (!this.options.url) throw new Error("Please provide a source MJPEG URL");

  this.mjpegOptions = {
    url: url.parse(options.url),
  };

  this.audienceResponses = [];
  this.newAudienceResponses = [];

  this.boundary = null;
  this.globalMjpegResponse = null;
  this.mjpegRequest = null;

  /// Helper functions ///
  const createRequest = () => {
    debugMjpeg("Send MJPEG request");
    return http.request(this.mjpegOptions.url, this.mjpegResponseHandler);
  };

  const cleanAudienceResponse = (res) => {
    debugClient(
      "Clean audience responses total clients %d with %d",
      this.audienceResponses.length,
      this.newAudienceResponses.length
    );
    const indexOf = this.audienceResponses.indexOf(res);

    if (indexOf >= 0) {
      this.audienceResponses.splice(indexOf, 1);
    }
    if (this.newAudienceResponses.indexOf(res) >= 0) {
      this.newAudienceResponses.splice(
        this.newAudienceResponses.indexOf(res),
        1
      ); // remove from new
    }

    if (this.audienceResponses.length === 0) {
      debugClient("No listening clients");
      this.mjpegRequest = null;
      if (this.globalMjpegResponse) {
        debugMjpeg("Destroying MPJEG response");
        this.globalMjpegResponse.destroy();
      }
    }
  };

  const newClient = (req, res) => {
    if (res.headersSent === false) {
      res.writeHead(200, {
        Expires: "Mon, 01 Jul 1980 00:00:00 GMT",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        "Content-Type": `multipart/x-mixed-replace;boundary=${this.boundary}`,
      });

      this.audienceResponses.push(res);
      this.newAudienceResponses.push(res);
      debugClient(
        "Total clients %d with %d",
        this.audienceResponses.length,
        this.newAudienceResponses.length
      );

      req.on("close", () => {
        debugClient("Client request is closed");
        cleanAudienceResponse(res);
      });
    }
  };

  const closeAllConnections = () => {
    this.audienceResponses.forEach((r) => {
      r.end();
      cleanAudienceResponse(r);
    });
  };

  // actual Express middleware
  this.proxyRequest = (req, res) => {
    debugClient("New proxy request received");

    if (this.mjpegRequest !== null) {
      // There is already another client consuming the MJPEG response
      newClient(req, res);
    } else {
      // Send source MJPEG request
      this.mjpegResponseHandler = function mjpegResponseHandler(mjpegResponse) {
        this.globalMjpegResponse = mjpegResponse;
        this.boundary = extractBoundary(mjpegResponse.headers["content-type"]);

        newClient(req, res);

        let lastByte1 = null;
        let lastByte2 = null;

        mjpegResponse.on("data", (chunk) => {
          // Fix CRLF issue on iOS 6+: boundary should be preceded by CRLF.
          let fixedChunk = chunk;
          if (lastByte1 != null && lastByte2 != null) {
            const oldheader = `--${this.boundary}`;
            const p = chunk.indexOf(oldheader);

            if (
              (p === 0 && !(lastByte2 === 0x0d && lastByte1 === 0x0a)) ||
              (p > 1 && !(chunk[p - 2] === 0x0d && chunk[p - 1] === 0x0a))
            ) {
              const b1 = chunk.slice(0, p);
              const b2 = Buffer.from(`\r\n--${this.boundary}`);
              const b3 = chunk.slice(p + oldheader.length);
              fixedChunk = Buffer.concat([b1, b2, b3]);
            }
          }

          lastByte1 = fixedChunk[fixedChunk.length - 1];
          lastByte2 = fixedChunk[fixedChunk.length - 2];

          this.audienceResponses.forEach((audience) => {
            // First time we push data... lets start at a boundary
            if (this.newAudienceResponses.indexOf(audience) >= 0) {
              const p = fixedChunk.indexOf(`--${this.boundary}`);
              if (p >= 0) {
                debugClient("Sending first image for client");
                audience.write(fixedChunk.slice(p));
                this.newAudienceResponses.splice(
                  this.newAudienceResponses.indexOf(audience),
                  1
                ); // remove from new
              }
            } else {
              audience.write(fixedChunk);
            }
          });
        });
        mjpegResponse.on("end", () => {
          debugMjpeg(
            "MJPEG Response has been ended, ending all active connections"
          );
          closeAllConnections();
        });
        mjpegResponse.on("close", () => {
          debugMjpeg("Response has been closed");
          this.mjpegRequest = null;
        });
      };

      this.mjpegRequest = createRequest();

      this.mjpegRequest.on("error", (e) => {
        debugMjpeg("Error with request: %s", e.message);
        this.mjpegRequest = null;
        this.retryCount = 0;
        const retry = () => {
          if (this.mjpegRequest === null) {
            debugMjpeg("Retrying MJPEG request");
            this.retryCount += 1;
            this.mjpegRequest = createRequest();

            this.mjpegRequest.on("error", (error) => {
              this.mjpegRequest = null;
              const maxRetries = 10;
              if (this.retryCount < maxRetries) {
                setTimeout(retry, 500);
              } else {
                debugMjpeg(
                  "Failed with error '%s' after %d tries close all clients",
                  error,
                  maxRetries
                );
                closeAllConnections();
              }
            });
          }
        };
        setTimeout(retry, 500);
      });
      this.mjpegRequest.end();
    }
  };
  return this;
};

module.exports = { MjpegProxy };

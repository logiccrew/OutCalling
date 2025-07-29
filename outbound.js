import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import createEvent from "./googleCalender.js";
import * as chrono from 'chrono-node';
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";

// Load environment variables from .env file
dotenv.config();

const userInput = {
  date: null,
  duration: null,
  name: null,
  email: null,
  timeZone: null,
};

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      machineDetection: 'Enable',
      machineDetectionTimeout: 5,
      to: number,
      url: `https://${request.headers.host
        }/outbound-call-twiml?prompt=${encodeURIComponent(
          prompt
        )}&first_message=${encodeURIComponent(first_message)}`,
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

fastify.all("/outbound-call-twiml", async (request, reply) => {
  try {
    const answeredBy = request.body?.AnsweredBy || "unknown";
    console.log("🔍 Answered by:", answeredBy);

    if (answeredBy === "human") {
      const prompt = request.query.prompt || "";
      const first_message = request.query.first_message || "";

      const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Connect>
            <Stream url="wss://${request.headers.host}/outbound-media-stream">
              <Parameter name="prompt" value="${prompt}" />
              <Parameter name="first_message" value="${first_message}" />
            </Stream>
          </Connect>
        </Response>`;

      reply.type("text/xml").send(twimlResponse);
    } else if (answeredBy === "machine_start") {
      const response = new VoiceResponse();
      response.say(
        "Hi, this is Oliver from AdraptrrixAI. We help businesses manage customer calls 24/7 using lifelike AI calling agents that sound just like real people and can even schedule appointments. If you're interested in learning more, feel free to reach out to us at 416206144. Looking forward to connecting!"
      );

      reply.type("text/xml").send(response.toString());
      response.hangup();
      console.log(response.toString());
    } else {
      // Fallback for unknown
      const response = new VoiceResponse();
      response.say("Hi, this is Oliver from AdraptrrixAI. Sorry we missed you!");
      reply.type("text/xml").send(response.toString());
      response.hangup();

      console.log(response.toString());
    }
  } catch (error) {
    console.error("❌ Error in /outbound-call-twiml:", error);
    reply.code(500).send("Internal Server Error");
  }
});

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null; // Add this to store parameters

      // Handle WebSocket errors
      ws.on("error", console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt:
                      customParameters?.prompt ||
                      "you are a gary from the phone store",
                  },
                  first_message:
                    customParameters?.first_message ||
                    "hey there! how can I help you today?",
                },
              },
            };

            console.log(
              "[ElevenLabs] Sending initial config with prompt:",
              initialConfig.conversation_config_override.agent.prompt.prompt
            );

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", data => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log(
                      "[ElevenLabs] Received audio but no StreamSid yet"
                    );
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(
                      JSON.stringify({
                        event: "clear",
                        streamSid,
                      })
                    );
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id,
                      })
                    );
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_transcript":
                  console.log(
                    `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                  );
                  const transcript = message.user_transcription_event?.user_transcript?.toLowerCase() || "";
                  const parsedDate = chrono.parseDate(transcript);
                  if (parsedDate) userInput.date = parsedDate;
                  if (transcript.includes("15 minutes")) userInput.duration = 15;
                  else if (transcript.includes("30 minutes")) userInput.duration = 30;
                  else if (transcript.includes("60 minutes") || transcript.includes("60 minutes")) userInput.duration = 60;

                  const emailMatch = transcript.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i);
                  if (emailMatch) userInput.email = emailMatch[0];

                  const nameMatch = transcript.match(/my name is ([a-zA-Z ]+)/i);
                  if (nameMatch) userInput.name = nameMatch[1].trim();

                  const tzMatch = transcript.match(/(america\/[a-z_]+|australia\/[a-z_]+|europe\/[a-z_]+)/i);
                  if (tzMatch) userInput.timeZone = tzMatch[0];

                  console.log("[User Input]:", userInput);

                  if (
                    userInput.date
                    // userInput.duration &&
                    // userInput.name &&
                    // userInput.email &&
                    // userInput.timeZone
                  ) {
                    try {
                      createEvent(userInput);
                      console.log("✅ Meeting booked successfully");
                    } catch (err) {
                      console.error("❌ Failed to create event:", err);
                    }
                  }

                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", error => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Connection closed");
          });
        } catch (error) {
          console.error("[ElevenLabs] Failed to setup WebSocket:", error);
        }
      };

      ws.on("message", async data => {
        try {
          const msg = JSON.parse(data);

          switch (msg.event) {
            case "start":
              streamSid = msg.streamSid;
              callSid = msg.callSid;
              customParameters = {};

              // Extract parameters sent from Twilio's Stream element
              if (msg.parameters && msg.parameters.length) {
                msg.parameters.forEach(param => {
                  if (param.name && param.value) {
                    customParameters[param.name] = param.value;
                  }
                });
              }

              console.log("[Server] Stream started with parameters:", customParameters);

              // Setup ElevenLabs connection now that we have parameters
              await setupElevenLabs();

              break;

            case "media":
              // Forward media to ElevenLabs as base64
              if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                const mediaPayload = msg.media?.payload || "";
                const mediaMsg = {
                  type: "media",
                  audio: {
                    chunk: mediaPayload,
                  },
                };
                elevenLabsWs.send(JSON.stringify(mediaMsg));
              }
              break;

            case "stop":
              streamSid = null;
              callSid = null;
              if (elevenLabsWs) {
                elevenLabsWs.close();
                elevenLabsWs = null;
              }
              console.log("[Server] Stream stopped");
              break;

            default:
              console.log("[Server] Unhandled event:", msg.event);
          }
        } catch (error) {
          console.error("[Server] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Server] Twilio media stream disconnected");
        if (elevenLabsWs) {
          elevenLabsWs.close();
          elevenLabsWs = null;
        }
      });
    }
  );
});

// Start the Fastify server on 0.0.0.0 so it's accessible externally
fastify.listen({ port: PORT, host: '0.0.0.0' }, err => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});

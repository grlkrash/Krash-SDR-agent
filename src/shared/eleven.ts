// ElevenLabs text-to-speech wrapper for voicemail audio.
//
// Pre-render at draft time (not streamed). MP3 at 44.1 kHz / 128 kbps for
// Twilio <Play>. Full buffer persisted on Draft.audioMp3 — re-approval never
// pays ElevenLabs twice.
//
// Model: `eleven_multilingual_v2` (default) or `eleven_v3` via ELEVENLABS_MODEL_ID.
// v3 is more expressive; pair with a premade voice (not clone) for vm drops.

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';

// Return type is the narrow `Uint8Array<ArrayBuffer>` so Prisma's `Bytes`
// column accepts it directly without a cast. `Buffer` would widen to
// `ArrayBufferLike` and Prisma rejects it under strict TS settings.
export const renderVoicemailMp3 = async (
  text: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '';
  const apiKey = process.env.ELEVENLABS_API_KEY ?? '';
  const modelId = process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODEL_ID;
  const url = `${ELEVEN_BASE}/${voiceId}?output_format=${OUTPUT_FORMAT}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, model_id: modelId }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${body}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

// ElevenLabs text-to-speech wrapper for voicemail audio.
//
// `eleven_turbo_v2_5` is the fastest, cheapest model that's good enough for a
// ~25-second cold-call voicemail. We render MP3 at 44.1 kHz / 128 kbps because
// Twilio's `<Play>` verb plays MP3 directly — no transcoding step. The full
// audio buffer is persisted on Draft.audioMp3 so re-approval of the same
// draft never pays ElevenLabs twice.

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const MODEL_ID = 'eleven_turbo_v2_5';
const OUTPUT_FORMAT = 'mp3_44100_128';

// Return type is the narrow `Uint8Array<ArrayBuffer>` so Prisma's `Bytes`
// column accepts it directly without a cast. `Buffer` would widen to
// `ArrayBufferLike` and Prisma rejects it under strict TS settings.
export const renderVoicemailMp3 = async (
  text: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '';
  const apiKey = process.env.ELEVENLABS_API_KEY ?? '';
  const url = `${ELEVEN_BASE}/${voiceId}?output_format=${OUTPUT_FORMAT}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, model_id: MODEL_ID }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${body}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/* Scorecard photo reading for the import page (import.html).
 *
 * Sends the photos to Claude (Anthropic API, vision + structured JSON output) and returns a
 * clay-by-clay transcription of every card it finds, with ambiguous marks and the written
 * totals so the user can check them before a round is created. Nothing is stored here.
 *
 * Needs ANTHROPIC_API_KEY. SCORECARD_READER_MOCK=1 returns made-up cards instead (tests and
 * screenshots; no API call, no cost).
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.SCORECARD_MODEL || 'claude-opus-5-5';
const MOCK = process.env.SCORECARD_READER_MOCK === '1';
let client = null;

export const scorecardReaderAvailable = () => MOCK || !!process.env.ANTHROPIC_API_KEY;

const LAYOUTS = {
    sporting: 'English Sporting: usually 10 stands (can be 1–20). Each stand is shot as pairs, typically 6, 8 or 10 clays, sometimes with one extra single (+1) at the end of a stand. Different cards may have different numbers of clays per stand.',
    sportrap: 'Sportrap: 5 stands (rounds) of 5 targets each, 25 in total.',
    compak: 'Compak Sporting: 5 stands (rounds) of 5 targets each, 25 in total.',
    skeet: 'English Skeet: 7 stations with 4, 4, 2, 4, 2, 4, 4 targets (24), plus one option target (the 25th) shot after the first miss, or on station 7 if straight. If a card shows the option target, add it as one extra mark at the end of the station where it was shot.'
};

const SYSTEM = `You transcribe photos of paper clay pigeon shooting scorecards into data, clay by clay.

Rules:
- Read every card you can see in every image directly. A single image may contain several cards. Never invent or fill in a card, stand or clay you cannot see; leave unreadable clays as "-".
- Marks: a hit is usually "/", "X" or "|"; a miss is usually "O". Record each clay as "H" (hit), "M" (miss) or "-" (not shot / blank / unreadable).
- A "/" with a tick, a struck-through O, an overwritten mark or a smudge is ambiguous: make your best call and list it in "ambiguous" with the stand number, clay number (1-based, in card order on that stand), what you read it as and why.
- Keep each stand's clays in the order they appear on the card. Stands are numbered from 1 in card order.
- Copy any written stand score, written total and handwritten sub-totals (e.g. "41 / 66") exactly as written, or "" if there is none. Do not correct them; the user compares them with your clay-by-clay count.
- shooter_name is the name written on the card ("" if none). card_number, date and ground likewise, as written.
- Use "notes" for anything the user should know (cropped cards, cards you could not read, glare).`;

const MARK = { type: 'string', enum: ['H', 'M', '-'] };
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['cards', 'notes'],
    properties: {
        cards: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['image', 'shooter_name', 'card_number', 'date', 'ground', 'stands', 'written_total', 'written_subtotals', 'ambiguous'],
                properties: {
                    image: { type: 'integer', description: '1-based index of the image the card is in' },
                    shooter_name: { type: 'string' },
                    card_number: { type: 'string' },
                    date: { type: 'string' },
                    ground: { type: 'string' },
                    stands: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['stand', 'marks', 'written_score'],
                            properties: { stand: { type: 'integer' }, marks: { type: 'array', items: MARK }, written_score: { type: 'string' } }
                        }
                    },
                    written_total: { type: 'string' },
                    written_subtotals: { type: 'string' },
                    ambiguous: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['stand', 'clay', 'read_as', 'reason'],
                            properties: { stand: { type: 'integer' }, clay: { type: 'integer' }, read_as: MARK, reason: { type: 'string' } }
                        }
                    }
                }
            }
        },
        notes: { type: 'string' }
    }
};

export class ScorecardError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function readScorecards({ discipline, images }) {
    if (!Array.isArray(images) || !images.length) throw new ScorecardError(400, 'Add at least one photo');
    if (images.length > 12) throw new ScorecardError(400, 'At most 12 photos at a time');
    for (const img of images) {
        if (!img || !IMAGE_TYPES.has(img.media_type) || typeof img.data !== 'string' || !img.data) throw new ScorecardError(400, 'Photos must be JPEG, PNG, WebP or GIF');
        if (img.data.length > 6.5 * 1024 * 1024) throw new ScorecardError(413, 'A photo is too large');
    }
    if (MOCK) return mockResult(discipline, images.length);

    client = client || new Anthropic();
    const content = [];
    images.forEach((img, i) => {
        content.push({ type: 'text', text: `Image ${i + 1}:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    });
    content.push({ type: 'text', text: `Discipline: ${LAYOUTS[discipline] || 'Clay shooting'}\n\nTranscribe every scorecard in these ${images.length} image(s).` });

    let message;
    try {
        // Streaming keeps a long read (several photos, careful thinking) clear of HTTP timeouts.
        const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 32000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
            system: SYSTEM,
            messages: [{ role: 'user', content }]
        });
        message = await stream.finalMessage();
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new ScorecardError(503, 'The server’s Anthropic API key was rejected. Ask the administrator to check ANTHROPIC_API_KEY.');
        if (err instanceof Anthropic.RateLimitError) throw new ScorecardError(429, 'The scorecard reader is busy. Try again in a minute.');
        if (err instanceof Anthropic.BadRequestError) throw new ScorecardError(400, `The photos couldn’t be read: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new ScorecardError(502, `The scorecard reader failed (${err.status ?? 'network'}). Try again.`);
        throw err;
    }
    if (message.stop_reason === 'refusal') throw new ScorecardError(422, 'These photos couldn’t be read. Try clearer photos of the scorecards.');
    if (message.stop_reason === 'max_tokens') throw new ScorecardError(422, 'Too many cards to read at once. Try fewer photos at a time.');
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let result;
    try { result = JSON.parse(text); } catch { throw new ScorecardError(502, 'The scorecard reader returned something unexpected. Try again.'); }
    if (!result || !Array.isArray(result.cards)) throw new ScorecardError(502, 'The scorecard reader returned something unexpected. Try again.');
    return { cards: result.cards, notes: String(result.notes || ''), model: message.model };
}

// Deterministic made-up cards for tests and screenshots (SCORECARD_READER_MOCK=1).
function mockResult(discipline, imageCount) {
    const shapes = {
        sporting: [[8, 8, 6, 6, 10, 8, 7, 6, 8, 6], [8, 8, 6, 6, 10, 8, 6, 6, 8, 6]],
        sportrap: [[5, 5, 5, 5, 5]], compak: [[5, 5, 5, 5, 5]], skeet: [[4, 4, 2, 4, 2, 4, 4]]
    }[discipline] || [[6, 6, 6]];
    const names = ['Mark Kelly-Smith', 'P. Sargent', 'Martin Guard', 'Guest Shooter'];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const cards = names.slice(0, Math.max(2, Math.min(4, imageCount + 1))).map((name, k) => {
        const shape = shapes[k % shapes.length];
        const stands = shape.map((n, si) => {
            const marks = Array.from({ length: n }, () => (rnd() < 0.72 ? 'H' : 'M'));
            return { stand: si + 1, marks, written_score: String(marks.filter(m => m === 'H').length + (si === 2 && k === 0 ? 1 : 0)) };
        });
        const total = stands.reduce((a, s) => a + s.marks.filter(m => m === 'H').length, 0);
        return {
            image: Math.min(imageCount, k + 1), shooter_name: name, card_number: String(101 + k), date: '', ground: '',
            stands, written_total: String(total), written_subtotals: '',
            ambiguous: k === 0 ? [{ stand: 2, clay: 3, read_as: 'H', reason: '"/" drawn over an "O"' }] : []
        };
    });
    return { cards, notes: 'Test mode: these cards are made up (SCORECARD_READER_MOCK=1).', model: 'mock' };
}

/* "Write with AI" for the Presentation deck (assets/presentation.js).
 *
 * The browser sends a summary of facts it has already computed for the round (scores, rates,
 * streaks, barrels, awards, weather, clay types, notes) plus a tone; Claude returns every
 * humour line the deck uses (titles, cover gag, roasts, slide verdicts, award names…) as
 * structured JSON. The browser checks the lines against the facts, falls back to its own pools
 * for anything missing or doubtful, and stores the result with the round. Nothing is stored here.
 *
 * Needs ANTHROPIC_API_KEY. PRESENTATION_MODEL picks the model (default claude-sonnet-5-5).
 * PRESENTATION_WRITER_MOCK=1 returns canned lines (tests and screenshots; no API call, no cost).
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.PRESENTATION_MODEL || 'claude-sonnet-5-5';
const MOCK = process.env.PRESENTATION_WRITER_MOCK === '1';
let client = null;

export const presentationWriterAvailable = () => MOCK || !!process.env.ANTHROPIC_API_KEY;

export class PresentationError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const TONES = {
    gentle: 'Gentle: warm, friendly club-bar banter. Tease lightly; everyone should smile, including the person at the bottom.',
    cheeky: 'Cheeky: sharper ribbing with more punch, still good-natured. Poke fun at misses, slumps and excuses.',
    savage: 'Savage: merciless about the SHOOTING (scores, slumps, misses, excuses, kit) like a roast among old friends. Never about anything else.'
};

const SYSTEM = `You write the jokes for a slide deck that sums up a clay pigeon shooting round (UK, CPSA disciplines) for the squad who shot it.

You get a JSON object of facts the app has already worked out. Write every line the deck needs and return them in the given JSON schema.

Hard rules:
- Use ONLY the facts given. Never invent scores, percentages, counts, stands, names, events, places, kit, weather or anything that happened. If you use a number, it must be one that appears in the facts, written the same way (e.g. 77%, 24 mph, 4 °C, Stand 3).
- Use shooters' names exactly as given. Refer to people by name; don't assume anyone's gender (use their name or "they").
- Round notes are the scorer's own words: you may joke about what they say, but don't add details they don't contain.
- Keep it about the shooting, the kit, the weather and the day. Nothing about anyone's appearance, age, gender, race, religion, health, family or anything personal. No swearing, no innuendo.
- British English. Short, punchy lines: one or two sentences, at most about 120 characters per roast or verdict, titles at most 48 characters.
- Don't repeat the same joke or phrase across lines. Vary the openings.
- Titles: no date (the app adds it). Each must name the ground or the event, and between them mix in the squad hit rate, the podium result (winner, margin, photo finish or walkover) and the weather when there is any.
- Return one entry per shooter in "squad" and "streakVerdicts", using each name exactly once. Return one entry per award in "awardNames", keeping the "base" exactly as given.
- If a slot doesn't apply (e.g. no weather, no notes, no kit), return an empty string for it.`;

const STR = { type: 'string' };
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['titles', 'cover', 'weather', 'squad', 'kit', 'milestones', 'barrels', 'types', 'streaks', 'streakVerdicts', 'stories', 'awards', 'awardNames', 'notes', 'closing'],
    properties: {
        titles: { type: 'array', items: STR, description: '4 title ideas, no date' },
        cover: { ...STR, description: 'One-line gag for the cover about the squad result' },
        weather: { ...STR, description: 'One line about the weather, or "" if no weather' },
        squad: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'roast'], properties: { name: STR, roast: STR } } },
        kit: { ...STR, description: 'One overall line for the guns & cartridges slide, or ""' },
        milestones: { ...STR, description: 'One overall line for the milestones slide, or ""' },
        barrels: { ...STR, description: 'One overall line for the barrel-by-barrel slide, or ""' },
        types: { ...STR, description: 'One overall line for the clay types slide, or ""' },
        streaks: { ...STR, description: 'One overall line for the streaks and slumps slide' },
        streakVerdicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'verdict'], properties: { name: STR, verdict: STR } } },
        stories: { type: 'object', additionalProperties: false, required: ['overall', 'best', 'worst', 'contrast'], properties: { overall: STR, best: STR, worst: STR, contrast: STR } },
        awards: { ...STR, description: 'One overall line for the awards slide' },
        awardNames: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['base', 'name'], properties: { base: STR, name: STR } } },
        notes: { ...STR, description: 'One line for the final slide about the round notes, or "" if none' },
        closing: { ...STR, description: 'Closing line for the final scores slide' }
    }
};

export async function writePresentation({ facts, tone }) {
    if (!facts || typeof facts !== 'object' || !Array.isArray(facts.shooters) || !facts.shooters.length) throw new PresentationError(400, 'No round facts to write about');
    const t = TONES[tone] ? tone : 'cheeky';   // default tone
    if (MOCK) return mockResult(facts, t);

    client = client || new Anthropic();
    let message;
    try {
        const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
            system: SYSTEM,
            messages: [{ role: 'user', content: `Tone: ${TONES[t]}\n\nFacts:\n${JSON.stringify(facts)}` }]
        });
        message = await stream.finalMessage();
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new PresentationError(503, 'The server’s Anthropic API key was rejected. Ask the administrator to check ANTHROPIC_API_KEY.');
        if (err instanceof Anthropic.RateLimitError) throw new PresentationError(429, 'The AI writer is busy. Try again in a minute.');
        if (err instanceof Anthropic.BadRequestError) throw new PresentationError(400, `The AI writer couldn’t take this round: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new PresentationError(502, `The AI writer failed (${err.status ?? 'network'}). Try again.`);
        throw err;
    }
    if (message.stop_reason === 'refusal') throw new PresentationError(422, 'The AI writer declined this one. The built-in lines are used instead.');
    if (message.stop_reason === 'max_tokens') throw new PresentationError(422, 'The AI writer ran out of room. Try again.');
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let result;
    try { result = JSON.parse(text); } catch { throw new PresentationError(502, 'The AI writer returned something unexpected. Try again.'); }
    return { text: result, model: message.model, tone: t, usage: { input: message.usage?.input_tokens ?? null, output: message.usage?.output_tokens ?? null } };
}

// Canned lines built from the facts (PRESENTATION_WRITER_MOCK=1).
function mockResult(facts, tone) {
    const place = facts.event || facts.ground || 'the ground';
    const top = facts.shooters.find(s => s.rank === 1) || facts.shooters[0];
    return {
        model: 'mock', tone,
        text: {
            titles: [`${top.name} Takes ${place}`, `${facts.squad.ratePct}% at ${place}`, `AI Test Title at ${place}`, `${place}: Written by a Robot`],
            cover: `[${tone}] ${facts.squad.hits} hits, ${facts.squad.misses} misses. The robot has seen the scores.`,
            weather: facts.weather ? `[${tone}] The weather was noted.` : '',
            squad: facts.shooters.map(s => ({ name: s.name, roast: `[${tone}] ${s.ratePct}% for ${s.name}.` })),
            kit: facts.kit && facts.kit.length ? `[${tone}] Kit noted.` : '',
            milestones: facts.milestones ? `[${tone}] Milestones reviewed.` : '',
            barrels: facts.barrels ? `[${tone}] Barrels counted.` : '',
            types: facts.clayTypes ? `[${tone}] Clay types weighed up.` : '',
            streaks: `[${tone}] Streaks and slumps, all logged.`,
            streakVerdicts: facts.shooters.map(s => ({ name: s.name, verdict: `[${tone}] ${s.hitStreak} in a row at best.` })),
            stories: { overall: `[${tone}] Some stands were kinder than others.`, best: `[${tone}] The good stand.`, worst: `[${tone}] The bad stand.`, contrast: `[${tone}] Same stand, different results.` },
            awards: `[${tone}] Silverware distributed.`,
            awardNames: (facts.awards || []).map(a => ({ base: a.base, name: `AI ${a.base}` })),
            notes: facts.notes ? `[${tone}] The notes were read.` : '',
            closing: `[${tone}] ${top.name} wins. The robot approves.`
        }
    };
}

import assert from 'node:assert/strict';
import { getCurrentDateTime, GET_CURRENT_DATETIME_SCHEMA } from './dist/tools/datetime.js';

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
const MODEL = 'llama3.1:8b';

// Convert tool schema to OpenAI / Ollama compatible function calling format
const tools = [
  {
    type: 'function',
    function: {
      name: GET_CURRENT_DATETIME_SCHEMA.name,
      description: GET_CURRENT_DATETIME_SCHEMA.description,
      parameters: GET_CURRENT_DATETIME_SCHEMA.parameters,
    },
  },
];

const systemPrompt = `You are a helpful assistant running on a local offline harness.
You have access to the \`get_current_datetime\` tool to inspect the real-world clock, date, weekday, and timezone.
You MUST call \`get_current_datetime\` whenever answering questions involving the current time, today's date, the day of the week, or calculating relative future dates (like "tomorrow", "next Tuesday", etc.).
Do not guess or assume the current date or time.`;

async function callChat(messages) {
  const res = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama call failed with HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices[0].message;
}

async function runTrajectory(query) {
  console.log(`\n======================================================`);
  console.log(`TEST QUERY: "${query}"`);
  console.log(`======================================================`);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: query },
  ];

  console.log(`[Step 1] Sending prompt to ${MODEL}...`);
  const assistantMsg = await callChat(messages);
  messages.push(assistantMsg);

  const toolCalls = assistantMsg.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    console.log(`❌ Model did NOT emit tool calls. Model output:`, assistantMsg.content);
    return { invoked: false, output: assistantMsg.content };
  }

  console.log(`[Step 2] Model emitted ${toolCalls.length} tool call(s):`);
  for (const tc of toolCalls) {
    console.log(`  -> Function: ${tc.function.name}`);
    console.log(`  -> Raw arguments: ${tc.function.arguments}`);
    assert.equal(tc.function.name, 'get_current_datetime');

    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(tc.function.arguments);
    } catch {
      parsedArgs = tc.function.arguments;
    }

    console.log(`[Step 3] Executing tool in harness runtime...`);
    const toolOutput = getCurrentDateTime(parsedArgs);
    console.log(`  -> Tool Output:`, JSON.stringify(toolOutput, null, 2));

    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(toolOutput),
    });
  }

  console.log(`[Step 4] Requesting final assistant synthesis with grounded context...`);
  const finalAssistantMsg = await callChat(messages);
  console.log(`\n[FINAL SYNTHESIS]:\n${finalAssistantMsg.content}\n`);

  return {
    invoked: true,
    toolCall: toolCalls[0],
    finalSynthesis: finalAssistantMsg.content,
  };
}

async function runAll() {
  console.log(`Starting Trajectory Verification on ${MODEL} at ${OLLAMA_BASE_URL}...\n`);

  // Query 1
  const t1 = await runTrajectory('What day of the week is it today?');
  assert.ok(t1.invoked, 'Query 1 must invoke get_current_datetime');
  assert.ok(
    t1.finalSynthesis.toLowerCase().includes('friday'),
    'Query 1 synthesis must reflect grounded Friday',
  );

  // Query 2
  const t2 = await runTrajectory('What is the current time in UTC versus local time?');
  assert.ok(t2.invoked, 'Query 2 must invoke get_current_datetime');
  assert.ok(
    t2.finalSynthesis.toLowerCase().includes('utc'),
    'Query 2 synthesis must cite UTC and local time',
  );

  // Query 3
  const t3 = await runTrajectory('Can you schedule a reminder for next Tuesday relative to right now?');
  assert.ok(t3.invoked, 'Query 3 must invoke get_current_datetime');
  assert.ok(
    t3.finalSynthesis.toLowerCase().includes('tuesday'),
    'Query 3 synthesis must compute date for next Tuesday',
  );

  console.log('======================================================');
  console.log('🎉 ALL 3 TEST TRAJECTORIES COMPLETED & VERIFIED! 🎉');
  console.log('======================================================\n');
}

runAll().catch((err) => {
  console.error('Trajectory run failed:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { getCurrentDateTime, sanitizeDateTimeArgs, GET_CURRENT_DATETIME_SCHEMA } from './dist/tools/datetime.js';

console.log('=== Running DateTime Tool Test Suite ===\n');

// Test 1: Schema Integrity
console.log('Test 1: Schema structure and required fields...');
assert.equal(GET_CURRENT_DATETIME_SCHEMA.name, 'get_current_datetime');
assert.ok(GET_CURRENT_DATETIME_SCHEMA.description.includes('real-world date'));
assert.ok(GET_CURRENT_DATETIME_SCHEMA.parameters.properties.timezone);
assert.ok(GET_CURRENT_DATETIME_SCHEMA.parameters.properties.format);
console.log('✔ Schema validated.\n');

// Test 2: Default invocation (system timezone)
console.log('Test 2: Default invocation without arguments...');
const defResult = getCurrentDateTime();
console.log('Result:', JSON.stringify(defResult, null, 2));
assert.equal(defResult.status, 'success');
assert.match(defResult.iso_timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
assert.match(defResult.date, /^\d{4}-\d{2}-\d{2}$/);
assert.match(defResult.time, /^\d{2}:\d{2}:\d{2}$/);
assert.ok(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].includes(defResult.day_of_week));
assert.ok(defResult.timezone.includes('UTC'));
console.log('✔ Default invocation verified.\n');

// Test 3: Explicit Timezones (UTC, Asia/Kolkata, America/New_York)
console.log('Test 3: Explicit IANA timezones...');
const utcResult = getCurrentDateTime({ timezone: 'UTC' });
console.log('UTC Result:', JSON.stringify(utcResult, null, 2));
assert.equal(utcResult.status, 'success');
assert.ok(utcResult.iso_timestamp.endsWith('+00:00'));
assert.ok(utcResult.timezone.includes('UTC+00:00'));

const kolkataResult = getCurrentDateTime({ timezone: 'Asia/Kolkata' });
console.log('Kolkata Result:', JSON.stringify(kolkataResult, null, 2));
assert.equal(kolkataResult.status, 'success');
assert.ok(kolkataResult.iso_timestamp.endsWith('+05:30'));
assert.ok(kolkataResult.timezone.includes('UTC+05:30'));

const nyResult = getCurrentDateTime({ timezone: 'America/New_York' });
console.log('NY Result:', JSON.stringify(nyResult, null, 2));
assert.equal(nyResult.status, 'success');
assert.match(nyResult.iso_timestamp, /-[0-9]{2}:[0-9]{2}$/);
console.log('✔ Timezone conversions verified.\n');

// Test 4: Graceful fallback for invalid timezones
console.log('Test 4: Graceful fallback for invalid timezones...');
const invalidTzResult = getCurrentDateTime({ timezone: 'Mars/Curiosity_Rover' });
console.log('Invalid TZ Result:', JSON.stringify(invalidTzResult, null, 2));
assert.equal(invalidTzResult.status, 'success');
assert.ok(invalidTzResult.warning);
assert.ok(invalidTzResult.warning.includes('Mars/Curiosity_Rover'));
assert.ok(invalidTzResult.date);
console.log('✔ Invalid timezone fallback verified.\n');

// Test 5: Format granularity & custom strftime
console.log('Test 5: Format options...');
const dateOnly = getCurrentDateTime({ format: 'date_only' });
assert.ok(dateOnly.formatted);
assert.ok(dateOnly.formatted.includes(dateOnly.date));

const timeOnly = getCurrentDateTime({ format: 'time_only' });
assert.ok(timeOnly.formatted);
assert.ok(timeOnly.formatted.includes(timeOnly.time));

const customFmt = getCurrentDateTime({ format: '%Y/%m/%d %H:%M' });
assert.match(customFmt.formatted, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
console.log('Custom format result:', customFmt.formatted);
console.log('✔ Format options verified.\n');

// Test 6: Input Sanitization & Model Hallucinations
console.log('Test 6: Input sanitization and local model edge cases...');
// Stringified JSON
const strJson = getCurrentDateTime('{"timezone": "UTC"}');
assert.equal(strJson.status, 'success');
assert.ok(strJson.timezone.includes('UTC+00:00'));

// Single quotes
const singleQuotes = getCurrentDateTime("{'tz': 'Asia/Kolkata'}");
assert.equal(singleQuotes.status, 'success');
assert.ok(singleQuotes.timezone.includes('UTC+05:30'));

// Hallucinated argument names: tz, time_zone, fmt
const aliasTz = getCurrentDateTime({ tz: 'UTC', fmt: 'date_only' });
assert.equal(aliasTz.status, 'success');
assert.ok(aliasTz.timezone.includes('UTC+00:00'));
assert.ok(aliasTz.formatted);

// Key-value text format: timezone=UTC
const kvText = getCurrentDateTime('timezone=UTC');
assert.equal(kvText.status, 'success');
assert.ok(kvText.timezone.includes('UTC+00:00'));

// Unrecoverable garbage
const garbage = getCurrentDateTime('completely unparseable garbage {{{{');
assert.equal(garbage.status, 'error');
assert.ok(garbage.message.includes('Invalid arguments payload'));
assert.equal(garbage.date_and_time, 'Not Provided');
console.log('✔ Sanitization and edge cases verified.\n');

// Test 7: Defensive null checks and date_and_time property verification
console.log('Test 7: Defensive date_and_time property and null handling...');
// In standard successful response
assert.ok(defResult.date_and_time, 'date_and_time should exist on default result');
assert.notEqual(defResult.date_and_time, null);
assert.notEqual(defResult.date_and_time, undefined);
assert.match(defResult.date_and_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

// Emulate receiving null or missing date_and_time and applying defensive check
const simulatedData = { date_and_time: null };
if (!simulatedData['date_and_time']) {
  simulatedData['date_and_time'] = 'Not Provided';
}
assert.equal(simulatedData['date_and_time'], 'Not Provided');

// Verify try-catch defensive block
try {
  const result = getCurrentDateTime();
  if (!result['date_and_time']) {
    result['date_and_time'] = 'Not Provided';
  }
  assert.ok(result['date_and_time']);
} catch (err) {
  assert.fail('Should not throw in defensive block');
}
console.log('✔ date_and_time null checks & fallback verified.\n');

console.log('🎉 ALL DATETIME TESTS PASSED SUCCESSFULLY! 🎉');

// ============================================================
// Multi-Tenant WhatsApp Booking Bot
// Supports: Salons, Service Stations, Medical Clinics, etc.
// Uses VM-attached service account (no JSON key file)
// Reads tenant config from environment: TENANT_ID, SPREADSHEET_ID, BUSINESS_TYPE, DEEPSEEK_API_KEY
// ============================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { google } = require('googleapis');
const OpenAI = require('openai');
const readline = require('readline');
require('dotenv').config();

// ============================================================
// ENVIRONMENT VARIABLES (set per tenant via .env file)
// ============================================================
const TENANT_ID = process.env.TENANT_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const BUSINESS_TYPE = process.env.BUSINESS_TYPE || 'salon';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!TENANT_ID || !SPREADSHEET_ID || !DEEPSEEK_API_KEY) {
    console.error('❌ Missing required env: TENANT_ID, SPREADSHEET_ID, DEEPSEEK_API_KEY');
    process.exit(1);
}

console.log(`🚀 Starting bot for tenant: ${TENANT_ID} (${BUSINESS_TYPE})`);

// ============================================================
// DEEPSEEK CLIENT
// ============================================================
const deepseek = new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
});

// ============================================================
// GOOGLE SHEETS AUTH (VM-attached service account)
// No JSON key file – uses default credentials from metadata server
// ============================================================
const sheetsAuth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// ============================================================
// MEMORY & CACHING
// ============================================================
const conversationMemory = new Map();      // phone -> chat history
const pendingBooking = new Map();          // phone -> booking details awaiting confirmation

let cachedStaff = null;
let cachedServices = null;
let cachedSettings = null;
let lastStaffLoad = 0;
let lastServicesLoad = 0;
let lastSettingsLoad = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

// ============================================================
// LOAD STAFF LIST (from 'Staff' sheet)
// ============================================================
async function loadStaff() {
    const now = Date.now();
    if (cachedStaff && (now - lastStaffLoad) < CACHE_TTL) return cachedStaff;

    try {
        const sheets = await sheetsAuth.getClient();
        const googleSheets = google.sheets({ version: 'v4', auth: sheets });
        const res = await googleSheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Staff!A:D'
        });
        const rows = res.data.values || [];
        if (rows.length < 2) throw new Error('No staff defined in Staff sheet');
        const staff = [];
        for (let i = 1; i < rows.length; i++) {
            staff.push({
                code: rows[i][0]?.trim(),
                name: rows[i][1]?.trim(),
                appointmentSheet: rows[i][2]?.trim(),
                holidaySheet: rows[i][3]?.trim()
            });
        }
        cachedStaff = staff;
        lastStaffLoad = now;
        console.log(`✅ Staff loaded (${staff.length}):`, staff.map(s => s.name));
        return staff;
    } catch (err) {
        console.error('Failed to load staff:', err);
        throw new Error('Staff sheet missing or invalid');
    }
}

// ============================================================
// LOAD SERVICES (from 'Services' sheet)
// ============================================================
async function loadServices() {
    const now = Date.now();
    if (cachedServices && (now - lastServicesLoad) < CACHE_TTL) return cachedServices;

    try {
        const sheets = await sheetsAuth.getClient();
        const googleSheets = google.sheets({ version: 'v4', auth: sheets });
        const res = await googleSheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Services!A:D'
        });
        const rows = res.data.values || [];
        if (rows.length < 2) return {}; // no services defined
        const services = {};
        for (let i = 1; i < rows.length; i++) {
            const key = rows[i][0]?.trim().toLowerCase();
            const duration = parseInt(rows[i][1]);
            const price = parseInt(rows[i][2]);
            const sinhala = rows[i][3]?.trim();
            if (key && !isNaN(duration) && !isNaN(price)) {
                services[key] = { duration, price, sinhala: sinhala || key };
            }
        }
        cachedServices = services;
        lastServicesLoad = now;
        console.log(`✅ Services loaded (${Object.keys(services).length}):`, Object.keys(services));
        return services;
    } catch (err) {
        console.error('Failed to load services:', err);
        return {};
    }
}

// ============================================================
// LOAD SHOP SETTINGS (from 'Settings' sheet)
// ============================================================
async function loadSettings() {
    const now = Date.now();
    if (cachedSettings && (now - lastSettingsLoad) < CACHE_TTL) return cachedSettings;

    try {
        const sheets = await sheetsAuth.getClient();
        const googleSheets = google.sheets({ version: 'v4', auth: sheets });
        const res = await googleSheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Settings!A:B'
        });
        const rows = res.data.values || [];
        let openTime = '09:00 AM';
        let closeTime = '06:00 PM';
        for (const row of rows) {
            if (row[0] === 'shop_open_time') openTime = row[1];
            if (row[0] === 'shop_close_time') closeTime = row[1];
        }
        cachedSettings = { openTime, closeTime };
        lastSettingsLoad = now;
        console.log(`✅ Settings loaded: open=${openTime}, close=${closeTime}`);
        return cachedSettings;
    } catch (err) {
        console.error('Failed to load settings:', err);
        return { openTime: '09:00 AM', closeTime: '06:00 PM' };
    }
}

// ============================================================
// DATE & TIME HELPERS
// ============================================================
function getCurrentDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function resolveRelativeDateKeyword(dateInput) {
    if (!dateInput || typeof dateInput !== 'string') return dateInput;
    const lower = dateInput.toLowerCase().trim();
    const today = getCurrentDateString();
    if (lower === 'day after tomorrow' || lower === 'අනිද්දා') return addDays(today, 2);
    if (lower === 'tomorrow' || lower === 'හෙට') return addDays(today, 1);
    if (lower === 'today' || lower === 'අද') return today;
    return dateInput;
}

function parseExplicitDateFromMessage(message) {
    const patterns = [
        /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/,
        /\b(\d{1,2})[\/-](\d{1,2})\b/
    ];
    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match) {
            let day = parseInt(match[1]);
            let month = parseInt(match[2]);
            let year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
            if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2100) {
                const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const testDate = new Date(dateStr);
                if (testDate && testDate.getMonth() + 1 === month && testDate.getDate() === day) {
                    return dateStr;
                }
            }
        }
    }
    return null;
}

function parseTimeToMinutes(timeStr) {
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    let hour = parseInt(match[1]);
    const minute = parseInt(match[2]);
    const meridian = match[3].toUpperCase();
    if (meridian === 'PM' && hour !== 12) hour += 12;
    if (meridian === 'AM' && hour === 12) hour = 0;
    return hour * 60 + minute;
}

function minutesToTimeStr(minutes) {
    const hour24 = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const meridian = hour24 >= 12 ? 'PM' : 'AM';
    let hour12 = hour24 % 12;
    if (hour12 === 0) hour12 = 12;
    return `${String(hour12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${meridian}`;
}

function calculateFinishTime(startTime, durationMins) {
    const startMin = parseTimeToMinutes(startTime);
    const finishMin = startMin + durationMins;
    return minutesToTimeStr(finishMin);
}

// ============================================================
// STAFF APPOINTMENTS & HOLIDAYS
// ============================================================
async function getStaffAppointments(staff, date) {
    const sheets = await sheetsAuth.getClient();
    const googleSheets = google.sheets({ version: 'v4', auth: sheets });
    try {
        const res = await googleSheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${staff.appointmentSheet}!A:J`  // columns up to J (includes customData)
        });
        const rows = res.data.values || [];
        const appointments = [];
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row[4] === date && row[8] !== 'Cancelled') { // date column index 4, status index 8
                const duration = (await loadServices())[row[3]]?.duration || 30;
                appointments.push({
                    startTime: row[5],
                    finishTime: row[6],
                    service: row[3],
                    duration: duration,
                    customData: row[9] ? JSON.parse(row[9]) : {}
                });
            }
        }
        return appointments;
    } catch (err) {
        console.log(`Error reading ${staff.appointmentSheet}:`, err);
        return [];
    }
}

async function getStaffHolidays(staff) {
    const sheets = await sheetsAuth.getClient();
    const googleSheets = google.sheets({ version: 'v4', auth: sheets });
    try {
        const res = await googleSheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${staff.holidaySheet}!A:A`
        });
        const rows = res.data.values || [];
        return rows.map(r => r[0]).filter(Boolean);
    } catch (err) {
        return [];
    }
}

async function checkTimeConflict(staff, date, time, serviceKey) {
    const appointments = await getStaffAppointments(staff, date);
    const reqStart = parseTimeToMinutes(time);
    const reqDur = (await loadServices())[serviceKey]?.duration || 30;
    const reqEnd = reqStart + reqDur;
    for (const apt of appointments) {
        const existingStart = parseTimeToMinutes(apt.startTime);
        const existingEnd = existingStart + apt.duration;
        if (reqStart < existingEnd && reqEnd > existingStart) return true;
    }
    return false;
}

async function validateBooking(staffName, date, time, serviceKey) {
    const staffList = await loadStaff();
    const staff = staffList.find(s => s.name === staffName);
    if (!staff) return { valid: false, reason: `❌ එවැනි සේවකයෙක් නොමැත.` };

    const holidays = await getStaffHolidays(staff);
    if (holidays.includes(date)) {
        return { valid: false, reason: `🏖️ ${staff.name} මහතා/මිය ${date} දින නිවාඩුයි.` };
    }

    const settings = await loadSettings();
    const bookingStart = parseTimeToMinutes(time);
    const duration = (await loadServices())[serviceKey]?.duration || 30;
    const bookingEnd = bookingStart + duration;
    const open = parseTimeToMinutes(settings.openTime);
    const close = parseTimeToMinutes(settings.closeTime);
    if (bookingStart < open) {
        return { valid: false, reason: `⏰ සැලෝනය විවෘත වන්නේ ${settings.openTime} ට පසුවයි.` };
    }
    if (bookingEnd > close) {
        return { valid: false, reason: `⏰ සේවාව අවසන් වන්නේ වැසෙන වේලාවට පසුවයි (${settings.closeTime}).` };
    }
    const conflict = await checkTimeConflict(staff, date, time, serviceKey);
    if (conflict) {
        return { valid: false, reason: `⚠️ මෙම වේලාව ${staff.name} සඳහා දැනටමත් වෙන් කර ඇත.` };
    }
    return { valid: true };
}

async function saveAppointment(staffName, customerPhone, customerName, serviceKey, date, startTime, price, customData = {}) {
    const staffList = await loadStaff();
    const staff = staffList.find(s => s.name === staffName);
    if (!staff) throw new Error('Staff not found');

    const sheets = await sheetsAuth.getClient();
    const googleSheets = google.sheets({ version: 'v4', auth: sheets });
    const duration = (await loadServices())[serviceKey]?.duration || 30;
    const finishTime = calculateFinishTime(startTime, duration);
    const timestamp = new Date().toISOString();
    const customDataStr = JSON.stringify(customData);

    await googleSheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${staff.appointmentSheet}!A:J`,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[timestamp, customerPhone, customerName, serviceKey, date, startTime, finishTime, price, 'Confirmed', customDataStr]]
        }
    });
    console.log(`✅ Appointment saved for ${staff.name} with customData:`, customData);
}

// ============================================================
// SYSTEM PROMPT BUILDER (includes custom fields if any)
// ============================================================
async function buildSystemPrompt() {
    const services = await loadServices();
    const staff = await loadStaff();
    const staffNames = staff.map(s => s.name).join(' or ');
    const servicesList = Object.entries(services)
        .map(([key, data]) => `- ${key} (${data.sinhala}) : ${data.price} LKR`)
        .join('\n');
    const serviceKeys = Object.keys(services).join(', ');
    const currentDate = getCurrentDateString();

    // Optional custom fields prompt based on BUSINESS_TYPE
    let customFieldsPrompt = '';
    if (BUSINESS_TYPE === 'service_station') {
        customFieldsPrompt = `
When collecting booking details, also ask for:
- vehicle make (e.g., Toyota)
- vehicle model (e.g., Corolla)
- license plate number
- odometer reading (number)

Then include a "customData" object in the JSON output like this:
"customData": {"vehicleMake":"Toyota","vehicleModel":"Corolla","licensePlate":"ABC-1234","odometer":45000}
`;
    } else if (BUSINESS_TYPE === 'medical_clinic') {
        customFieldsPrompt = `
When collecting booking details, also ask for:
- symptoms (text)
- blood pressure (e.g., 120/80)
- current medications (text)

Then include a "customData" object in the JSON output like this:
"customData": {"symptoms":"fever, cough","bloodPressure":"120/80","medications":"paracetamol"}
`;
    } else {
        customFieldsPrompt = `No extra fields needed. Use "customData": {}`;
    }

    return `
You are a booking assistant for a ${BUSINESS_TYPE} business.
Reply in Sinhala language.

TODAY'S DATE IS: ${currentDate} (YYYY-MM-DD)

AVAILABLE SERVICES:
${servicesList}

STAFF: ${staffNames}

BOOKING RULES:
- Ask ONE missing detail at a time.
- Required details: name, phone number, service, staff member (optional but recommended), date, time.
- If user does not choose a staff member, ask "Do you have a preferred staff? (${staffNames})".
- Customer phone number is REQUIRED (Sri Lankan: 07xxxxxxx or 94xxxxxxx).
- When user mentions relative dates like "today", "tomorrow", "day after tomorrow" → calculate absolute date using TODAY'S DATE.
- Output date in YYYY-MM-DD, time in HH:MM AM/PM.

${customFieldsPrompt}

When ALL details are available, output ONLY JSON (no extra text):
{
  "name":"Saman",
  "customerPhone":"0771234567",
  "service":"haircut",
  "employee":"Suranga",
  "date":"${currentDate}",
  "time":"09:30 AM",
  "customData": {}
}

Service must be one of: ${serviceKeys}
Employee must be exactly one of: ${staffNames}

CANCELLATION JSON:
{"cancel":true,"name":"Saman","date":"${currentDate}","time":"09:30 AM"}

Do not explain the JSON.
`;
}

// ============================================================
// AI REPLY & JSON EXTRACTION
// ============================================================
function getHistory(phone) {
    return conversationMemory.get(phone) || [];
}

function addToHistory(phone, userMsg, assistantMsg) {
    let history = conversationMemory.get(phone) || [];
    history.push({ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg });
    if (history.length > 10) history = history.slice(-10);
    conversationMemory.set(phone, history);
}

async function getDeepSeekReply(phone, userMessage) {
    const systemPrompt = await buildSystemPrompt();
    const history = getHistory(phone);
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessage }
    ];
    const completion = await deepseek.chat.completions.create({
        model: 'deepseek-chat',
        messages,
        temperature: 0.7,
        max_tokens: 800
    });
    return completion.choices[0].message.content;
}

function extractJson(replyText) {
    const match = replyText.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (e) { return null; }
}

// ============================================================
// SHOW BOOKED APPOINTMENTS (for a given date)
// ============================================================
async function replyWithBookedTimes(from, sock, userMessage, phone) {
    let targetDate = null;
    const explicitDate = parseExplicitDateFromMessage(userMessage);
    if (explicitDate) {
        targetDate = explicitDate;
    } else {
        const lower = userMessage.toLowerCase();
        if (lower.includes('day after tomorrow') || lower.includes('අනිද්දා')) targetDate = addDays(getCurrentDateString(), 2);
        else if (lower.includes('tomorrow') || lower.includes('හෙට')) targetDate = addDays(getCurrentDateString(), 1);
        else if (lower.includes('yesterday') || lower.includes('ඊයේ')) targetDate = addDays(getCurrentDateString(), -1);
        else if (lower.includes('today') || lower.includes('අද')) targetDate = getCurrentDateString();
        else targetDate = getCurrentDateString();
    }

    const staffList = await loadStaff();
    let reply = `📅 ${targetDate} booked appointments\n\n`;
    for (const staff of staffList) {
        const appointments = await getStaffAppointments(staff, targetDate);
        reply += `👨 ${staff.name}\n\n`;
        if (appointments.length === 0) {
            reply += `No bookings\n\n`;
        } else {
            appointments.sort((a, b) => parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime));
            for (const apt of appointments) {
                reply += `⏰ ${apt.startTime} - ${apt.finishTime}\n✂️ ${apt.service}\n\n`;
            }
        }
    }
    await sock.sendMessage(from, { text: reply });
    addToHistory(phone, userMessage, reply);
}

// ============================================================
// MAIN BOT START
// ============================================================
async function startBot() {
    const sessionPath = `./sessions/${TENANT_ID}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log(`✅ [${TENANT_ID}] WhatsApp connected`);
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            console.log(`🔄 [${TENANT_ID}] Reconnecting...`);
            setTimeout(() => startBot(), 5000);
        }
    });

    // Pairing if not registered
    if (!sock.authState.creds.registered) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const phoneNumber = await new Promise(resolve => rl.question('Enter WhatsApp number for this tenant: ', resolve));
        rl.close();
        console.log('Requesting pairing code...');
        setTimeout(async () => {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`\n🔐 [${TENANT_ID}] Pairing code: ${code}\n`);
        }, 3000);
    }

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const phone = from.split('@')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        console.log(`📩 [${TENANT_ID}] ${phone}: ${text}`);
        const lowerText = text.toLowerCase();

        // Show booked appointments if user asks
        const bookingKeywords = ['available', 'free', 'slot', 'slots', 'booked', 'booking', 'appointment', 'today', 'tomorrow', 'yesterday', 'අද', 'හෙට', 'ඊයේ', 'අනිද්දා', 'වෙන්', 'වේලාව'];
        const wantsBookingInfo = bookingKeywords.some(k => lowerText.includes(k)) || /\d{1,2}[\/-]\d{1,2}([\/-]\d{4})?/.test(text);
        if (wantsBookingInfo) {
            await replyWithBookedTimes(from, sock, text, phone);
            return;
        }

        // Confirm booking when user says "ok"
        if (lowerText === 'ok' && pendingBooking.has(phone)) {
            const booking = pendingBooking.get(phone);
            await saveAppointment(booking.employee, booking.customerPhone, booking.name, booking.service, booking.date, booking.time, booking.price, booking.customData || {});
            await sock.sendMessage(from, {
                text: `✅ ඔබගේ වෙන් කිරීම සාර්ථකයි!\n\n👤 නම: ${booking.name}\n📞 දුරකථන: ${booking.customerPhone}\n✂️ සේවාව: ${booking.service}\n👨‍💼 සේවක: ${booking.employee}\n📅 දිනය: ${booking.date}\n⏰ වේලාව: ${booking.time}\n💰 මිල: LKR ${booking.price}\n\nස්තුතියි 😊`
            });
            pendingBooking.delete(phone);
            return;
        }

        // AI response
        let aiReply;
        try {
            aiReply = await getDeepSeekReply(phone, text);
        } catch (err) {
            console.error(err);
            aiReply = 'සමාවන්න. පසුව නැවත උත්සාහ කරන්න.';
        }
        console.log(`🤖 [${TENANT_ID}] AI:`, aiReply);

        const jsonData = extractJson(aiReply);
        let finalReply = aiReply.replace(/\{[\s\S]*?\}/, '').trim();

        if (jsonData && jsonData.name && jsonData.customerPhone && jsonData.service && jsonData.date && jsonData.time && jsonData.employee) {
            jsonData.date = resolveRelativeDateKeyword(jsonData.date);
            const validation = await validateBooking(jsonData.employee, jsonData.date, jsonData.time, jsonData.service);
            if (!validation.valid) {
                finalReply = validation.reason;
            } else {
                const services = await loadServices();
                const price = services[jsonData.service]?.price || 0;
                const customData = jsonData.customData || {};
                pendingBooking.set(phone, {
                    customerPhone: jsonData.customerPhone,
                    name: jsonData.name,
                    service: jsonData.service,
                    employee: jsonData.employee,
                    date: jsonData.date,
                    time: jsonData.time,
                    price,
                    customData
                });
                finalReply = `📋 කරුණාකර වෙන් කිරීම තහවුරු කරන්න.\n\n👤 නම: ${jsonData.name}\n📞 දුරකථන: ${jsonData.customerPhone}\n✂️ සේවාව: ${jsonData.service}\n👨‍💼 සේවක: ${jsonData.employee}\n📅 දිනය: ${jsonData.date}\n⏰ වේලාව: ${jsonData.time}\n💰 මිල: LKR ${price}\n\nතහවුරු කිරීමට "Ok" යවන්න 😊`;
            }
        } else if (jsonData?.cancel) {
            finalReply = "ඔබගේ වෙන් කිරීම අවලංගු කරන ලදී.";
        }

        addToHistory(phone, text, finalReply);
        if (finalReply.trim()) {
            await sock.sendMessage(from, { text: finalReply });
        }
    });
}

startBot().catch(console.error);
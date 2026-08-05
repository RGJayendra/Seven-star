const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== GOOGLE AUTH ====================
const auth = new google.auth.GoogleAuth({
    keyFile: './google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function getSheets() {
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
}

// ==================== HELPERS ====================
function convertTo24(time12) {
    const match = time12.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return "09:00";
    let hour = parseInt(match[1]);
    const minute = match[2];
    const meridian = match[3].toUpperCase();
    if (meridian === 'PM' && hour !== 12) hour += 12;
    if (meridian === 'AM' && hour === 12) hour = 0;
    return String(hour).padStart(2, '0') + ':' + minute;
}

function convertTo12(time24) {
    const [hour24, minute] = time24.split(':');
    let hour = parseInt(hour24);
    const meridian = hour >= 12 ? 'PM' : 'AM';
    let hour12 = hour % 12;
    if (hour12 === 0) hour12 = 12;
    return String(hour12).padStart(2, '0') + ':' + minute + ' ' + meridian;
}

// ==================== HTML PAGE ====================
const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>7 Star Salon Admin - 2 Employees</title>
<style>
*{box-sizing:border-box;font-family:system-ui,Segoe UI,Roboto;}
body{background:#f0f4f8;margin:0;padding:20px;}
.container{max-width:1200px;margin:0 auto;}
.card{background:white;border-radius:28px;padding:20px;margin-bottom:20px;box-shadow:0 8px 20px rgba(0,0,0,0.08);}
.tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;}
.tab{background:#e0e0e0;padding:10px 20px;border-radius:40px;cursor:pointer;}
.tab.active{background:#25D366;color:white;}
.tab-content{display:none;}
.tab-content.active{display:block;}
table{width:100%;border-collapse:collapse;margin-top:10px;}
th,td{border:1px solid #ddd;padding:8px;text-align:left;}
th{background:#075E54;color:white;}
button{background:#25D366;border:none;padding:8px 16px;border-radius:20px;cursor:pointer;margin:5px;}
button.danger{background:#dc3545;color:white;}
input,select{padding:8px;margin:5px;border-radius:20px;border:1px solid #ccc;}
.form-group{margin:10px 0;}
.appointment-item{background:#f9f9f9;margin:8px 0;padding:10px;border-radius:16px;display:flex;justify-content:space-between;flex-wrap:wrap;}
.error{color:red;padding:10px;}
</style>
</head>
<body>
<div class="container">
<div class="card">
<h1>✂️ 7 Star Salon Admin (2 Employees)</h1>
<div class="tabs">
    <div class="tab active" data-tab="emp1">👤 Employee 1 Appointments</div>
    <div class="tab" data-tab="emp2">👤 Employee 2 Appointments</div>
    <div class="tab" data-tab="services">💇 Services</div>
    <div class="tab" data-tab="holidays1">🏖️ Employee 1 Holidays</div>
    <div class="tab" data-tab="holidays2">🏖️ Employee 2 Holidays</div>
    <div class="tab" data-tab="hours">⏰ Shop Hours</div>
</div>

<!-- Employee 1 Appointments -->
<div id="emp1" class="tab-content active">
    <input type="date" id="emp1Date">
    <button onclick="loadAppointments('emp1')">Show</button>
    <div id="emp1AppointmentsList"></div>
</div>

<!-- Employee 2 Appointments -->
<div id="emp2" class="tab-content">
    <input type="date" id="emp2Date">
    <button onclick="loadAppointments('emp2')">Show</button>
    <div id="emp2AppointmentsList"></div>
</div>

<!-- Services (shared) -->
<div id="services" class="tab-content">
    <h3>Manage Services</h3>
    <div id="servicesList"></div>
    <h4>Add/Edit Service</h4>
    <input type="hidden" id="editServiceOriginal">
    <div class="form-group"><input type="text" id="serviceKey" placeholder="Service name"></div>
    <div class="form-group"><input type="number" id="serviceDuration" placeholder="Duration (mins)"></div>
    <div class="form-group"><input type="number" id="servicePrice" placeholder="Price LKR"></div>
    <div class="form-group"><input type="text" id="serviceSinhala" placeholder="Sinhala name"></div>
    <button onclick="saveService()">Save Service</button>
</div>

<!-- Employee 1 Holidays -->
<div id="holidays1" class="tab-content">
    <h3>Employee 1 Holidays</h3>
    <input type="date" id="holiday1Date"><button onclick="addHoliday(1)">Add Holiday</button>
    <div id="holidays1List"></div>
</div>

<!-- Employee 2 Holidays -->
<div id="holidays2" class="tab-content">
    <h3>Employee 2 Holidays</h3>
    <input type="date" id="holiday2Date"><button onclick="addHoliday(2)">Add Holiday</button>
    <div id="holidays2List"></div>
</div>

<!-- Shop Hours -->
<div id="hours" class="tab-content">
    <h3>Shop Hours</h3>
    <div class="form-group"><label>Open Time</label><input type="time" id="openTime"></div>
    <div class="form-group"><label>Close Time</label><input type="time" id="closeTime"></div>
    <button onclick="saveHours()">Save Hours</button>
</div>
</div>
</div>

<script>
// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(tab.dataset.tab).classList.add('active');
        if(tab.dataset.tab === 'services') loadServices();
        if(tab.dataset.tab === 'holidays1') loadHolidays(1);
        if(tab.dataset.tab === 'holidays2') loadHolidays(2);
        if(tab.dataset.tab === 'hours') loadHours();
        if(tab.dataset.tab === 'emp1') loadAppointments('emp1');
        if(tab.dataset.tab === 'emp2') loadAppointments('emp2');
    });
});

async function loadAppointments(empId) {
    try {
        const dateInput = document.getElementById(empId + 'Date');
        let date = dateInput.value || new Date().toISOString().split('T')[0];
        dateInput.value = date;
        const res = await fetch(\`/api/appointments/\${empId}?date=\${date}\`);
        const appointments = await res.json();
        const container = document.getElementById(empId + 'AppointmentsList');
        if(!appointments.length){
            container.innerHTML = '<div>No appointments</div>';
            return;
        }
        let html = '';
        appointments.forEach(apt => {
            html += \`<div class="appointment-item">
                <div><strong>\${apt.startTime} - \${apt.finishTime}</strong></div>
                <div>\${apt.name} - \${apt.service} - LKR \${apt.price}</div>
                <div>📞 \${apt.phone}</div>
            </div>\`;
        });
        container.innerHTML = html;
    } catch(err){
        document.getElementById(empId+'AppointmentsList').innerHTML = '<div class="error">'+err.message+'</div>';
    }
}

// Services
async function loadServices(){
    try{
        const res = await fetch('/api/services');
        const services = await res.json();
        let html = '<table><th>Service</th><th>Duration</th><th>Price</th><th>Sinhala</th><th>Actions</th></tr>';
        services.forEach(s => {
            html += \`<tr>
                <td>\${s.service}</td><td>\${s.duration}</td><td>\${s.price}</td><td>\${s.sinhala||''}</td>
                <td><button onclick="editService('\${s.service}','\${s.duration}','\${s.price}','\${s.sinhala||''}')">Edit</button>
                <button class="danger" onclick="deleteService('\${s.service}')">Delete</button></td>
            </tr>\`;
        });
        html += '</table>';
        document.getElementById('servicesList').innerHTML = html;
    } catch(err){
        document.getElementById('servicesList').innerHTML = '<div class="error">'+err.message+'</div>';
    }
}
function editService(service,duration,price,sinhala){
    document.getElementById('editServiceOriginal').value = service;
    document.getElementById('serviceKey').value = service;
    document.getElementById('serviceDuration').value = duration;
    document.getElementById('servicePrice').value = price;
    document.getElementById('serviceSinhala').value = sinhala;
}
async function saveService(){
    const originalService = document.getElementById('editServiceOriginal').value;
    const service = document.getElementById('serviceKey').value;
    const duration = document.getElementById('serviceDuration').value;
    const price = document.getElementById('servicePrice').value;
    const sinhala = document.getElementById('serviceSinhala').value;
    await fetch('/api/services', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({service,duration,price,sinhala,originalService})
    });
    loadServices();
}
async function deleteService(service){
    if(confirm('Delete service?')){
        await fetch('/api/services/'+encodeURIComponent(service),{method:'DELETE'});
        loadServices();
    }
}

// Holidays per employee
async function loadHolidays(empNum){
    const res = await fetch(\`/api/holidays/\${empNum}\`);
    const holidays = await res.json();
    let html = '<ul>';
    holidays.forEach(h => {
        html += \`<li>\${h} <button class="danger" onclick="deleteHoliday(\${empNum},'\${h}')">Delete</button></li>\`;
    });
    html += '</ul>';
    document.getElementById(\`holidays\${empNum}List\`).innerHTML = html;
}
async function addHoliday(empNum){
    const date = document.getElementById(\`holiday\${empNum}Date\`).value;
    await fetch(\`/api/holidays/\${empNum}\`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({date})
    });
    loadHolidays(empNum);
}
async function deleteHoliday(empNum, date){
    await fetch(\`/api/holidays/\${empNum}/\${encodeURIComponent(date)}\`,{method:'DELETE'});
    loadHolidays(empNum);
}

// Shop hours
async function loadHours(){
    const res = await fetch('/api/shophours');
    const data = await res.json();
    document.getElementById('openTime').value = data.open24;
    document.getElementById('closeTime').value = data.close24;
}
async function saveHours(){
    const open = document.getElementById('openTime').value;
    const close = document.getElementById('closeTime').value;
    await fetch('/api/shophours',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({open,close})
    });
    alert('Saved');
}

// Initial load
document.getElementById('emp1Date').value = new Date().toISOString().split('T')[0];
document.getElementById('emp2Date').value = new Date().toISOString().split('T')[0];
loadAppointments('emp1');
</script>
</body>
</html>`;

// ==================== ROUTES ====================

app.get('/', (req, res) => res.send(HTML_PAGE));

// Services (shared)
app.get('/api/services', async (req,res)=>{
    try{
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Config!A:D' });
        const rows = response.data.values || [];
        const services = [];
        for(let i=1;i<rows.length;i++) services.push({ service: rows[i][0]||'', duration: rows[i][1]||'', price: rows[i][2]||'', sinhala: rows[i][3]||'' });
        res.json(services);
    } catch(err){ res.status(500).json({error:err.message}); }
});

app.post('/api/services', async (req,res)=>{
    try{
        const {service,duration,price,sinhala,originalService} = req.body;
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Config!A:D' });
        let rows = response.data.values || [];
        if(!rows.length) rows = [['service_key','duration_mins','price_lkr','sinhala_name']];
        let found = false;
        for(let i=1;i<rows.length;i++){
            if(rows[i][0] === originalService){
                rows[i] = [service,duration,price,sinhala];
                found = true;
            }
        }
        if(!found) rows.push([service,duration,price,sinhala]);
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range:'Config!A:D', valueInputOption:'USER_ENTERED', resource:{ values: rows } });
        res.json({success:true});
    } catch(err){ res.status(500).json({error:err.message}); }
});

app.delete('/api/services/:service', async (req,res)=>{
    try{
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range:'Config!A:D' });
        const rows = response.data.values || [];
        const filtered = rows.filter((row,idx)=> idx===0 || row[0] !== req.params.service);
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range:'Config!A:D', valueInputOption:'USER_ENTERED', resource:{ values: filtered } });
        res.json({success:true});
    } catch(err){ res.status(500).json({error:err.message}); }
});

// Holidays per employee (1 or 2)
async function getEmployeeSheetNames() {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:C' });
    const rows = res.data.values || [];
    if(rows.length<2) throw new Error('Employees sheet missing');
    return { emp1: rows[1][2], emp2: rows[2][2] }; // holidaySheet column
}
app.get('/api/holidays/:empNum', async (req,res)=>{
    try{
        const { empNum } = req.params;
        const sheets = await getSheets();
        const { emp1, emp2 } = await getEmployeeSheetNames();
        const holidaySheet = empNum == '1' ? emp1 : emp2;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${holidaySheet}!A:A` });
        const rows = response.data.values || [];
        res.json(rows.map(r=>r[0]).filter(Boolean));
    } catch(err){ res.status(500).json({error:err.message}); }
});
app.post('/api/holidays/:empNum', async (req,res)=>{
    try{
        const { empNum } = req.params;
        const { date } = req.body;
        const sheets = await getSheets();
        const { emp1, emp2 } = await getEmployeeSheetNames();
        const holidaySheet = empNum == '1' ? emp1 : emp2;
        await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range:`${holidaySheet}!A:A`, valueInputOption:'USER_ENTERED', resource:{ values:[[date]] } });
        res.json({success:true});
    } catch(err){ res.status(500).json({error:err.message}); }
});
app.delete('/api/holidays/:empNum/:date', async (req,res)=>{
    try{
        const { empNum, date } = req.params;
        const sheets = await getSheets();
        const { emp1, emp2 } = await getEmployeeSheetNames();
        const holidaySheet = empNum == '1' ? emp1 : emp2;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${holidaySheet}!A:A` });
        const rows = response.data.values || [];
        const filtered = rows.filter(r => r[0] !== date);
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range:`${holidaySheet}!A:A`, valueInputOption:'USER_ENTERED', resource:{ values: filtered } });
        res.json({success:true});
    } catch(err){ res.status(500).json({error:err.message}); }
});

// Shop hours (shared)
app.get('/api/shophours', async (req,res)=>{
    try{
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range:'Settings!A:B' });
        const rows = response.data.values || [];
        let open='09:00 AM', close='06:00 PM';
        rows.forEach(r=>{ if(r[0]==='shop_open_time') open=r[1]; if(r[0]==='shop_close_time') close=r[1]; });
        res.json({ open, close, open24: convertTo24(open), close24: convertTo24(close) });
    } catch(err){ res.status(500).json({error:err.message}); }
});
app.post('/api/shophours', async (req,res)=>{
    try{
        const sheets = await getSheets();
        const data = [ ['shop_open_time', convertTo12(req.body.open)], ['shop_close_time', convertTo12(req.body.close)] ];
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range:'Settings!A:B', valueInputOption:'USER_ENTERED', resource:{ values:data } });
        res.json({success:true});
    } catch(err){ res.status(500).json({error:err.message}); }
});

// Appointments per employee (emp1 or emp2)
async function getEmployeeAppointmentSheet(empId) {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:C' });
    const rows = res.data.values || [];
    if(rows.length<2) throw new Error('Employees sheet missing');
    if(empId === 'emp1') return rows[1][1];
    if(empId === 'emp2') return rows[2][1];
    throw new Error('Invalid employee id');
}
app.get('/api/appointments/:empId', async (req,res)=>{
    try{
        const { empId } = req.params;
        const date = req.query.date;
        const sheetName = await getEmployeeAppointmentSheet(empId);
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range:`${sheetName}!A:I` });
        const rows = response.data.values || [];
        if(rows.length<2) return res.json([]);
        const headers = rows[0];
        const dateIdx = headers.findIndex(h => h?.toLowerCase().includes('date'));
        const nameIdx = headers.findIndex(h => h?.toLowerCase().includes('name'));
        const serviceIdx = headers.findIndex(h => h?.toLowerCase().includes('service'));
        const startIdx = headers.findIndex(h => h?.toLowerCase().includes('start'));
        const finishIdx = headers.findIndex(h => h?.toLowerCase().includes('finish'));
        const phoneIdx = headers.findIndex(h => h?.toLowerCase().includes('phone'));
        const priceIdx = headers.findIndex(h => h?.toLowerCase().includes('price'));
        const appointments = [];
        for(let i=1;i<rows.length;i++){
            if(rows[i][dateIdx] === date && rows[i][8] !== 'Cancelled'){
                appointments.push({
                    name: rows[i][nameIdx] || '',
                    service: rows[i][serviceIdx] || '',
                    startTime: rows[i][startIdx] || '',
                    finishTime: rows[i][finishIdx] || '',
                    phone: rows[i][phoneIdx] || '',
                    price: rows[i][priceIdx] || ''
                });
            }
        }
        appointments.sort((a,b)=>a.startTime.localeCompare(b.startTime));
        res.json(appointments);
    } catch(err){ res.status(500).json({error:err.message}); }
});

app.listen(PORT, () => {
    console.log(`\n==============================`);
    console.log(`SALON DASHBOARD STARTED (2 Employee mode)`);
    console.log(`==============================\n`);
    console.log(`URL: http://localhost:${PORT}\n`);
});
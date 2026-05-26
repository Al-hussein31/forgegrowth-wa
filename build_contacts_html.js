const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/wa_contacts.json', 'utf8'));

function escape(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function timeAgo(d) {
    if (!d) return 'Never';
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(d).toLocaleDateString();
}

let rows = '';
let contactId = 0;

for (const c of data.contacts) {
    const dir = c.lastFromYou ? '📤' : '📥';
    const unread = c.unread > 0 ? `<span class="badge">${c.unread}</span>` : '';
    rows += `<tr>
        <td><input type="checkbox" class="select-contact" data-idx="${contactId}" checked></td>
        <td>${escape(c.name)}</td>
        <td>${escape(c.number)}</td>
        <td>${dir} ${timeAgo(c.lastDate)}</td>
        <td class="msg">${escape(c.lastText)}</td>
        <td>${unread}</td>
    </tr>`;
    contactId++;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ForgeGrowth — Contact Selector</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f0f1a; color: #e0e0e0; padding: 20px;
}
.header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 20px; background: #1a1a2e; border-radius: 12px; margin-bottom: 20px;
    border: 1px solid #2a2a4a;
}
.header h1 { font-size: 20px; color: #fff; }
.header span { color: #888; font-size: 14px; }
.controls {
    display: flex; gap: 12px; margin-bottom: 16px; align-items: center; flex-wrap: wrap;
}
.controls input, .controls select {
    padding: 8px 14px; border-radius: 8px; border: 1px solid #2a2a4a;
    background: #1a1a2e; color: #e0e0e0; font-size: 14px;
}
.controls input::placeholder { color: #555; }
.controls button {
    padding: 8px 20px; border: none; border-radius: 8px; cursor: pointer;
    font-size: 14px; font-weight: 600; transition: all 0.2s;
}
.btn-primary { background: #6c5ce7; color: #fff; }
.btn-primary:hover { background: #5a4bd1; transform: translateY(-1px); }
.btn-danger { background: #e74c3c; color: #fff; }
.btn-danger:hover { background: #c0392b; }
.btn-success { background: #2ecc71; color: #fff; }
.btn-success:hover { background: #27ae60; }
.btn-outline { background: transparent; color: #888; border: 1px solid #2a2a4a; }
.btn-outline:hover { border-color: #6c5ce7; color: #6c5ce7; }
.count { color: #888; font-size: 14px; }
.table-wrap {
    background: #1a1a2e; border-radius: 12px; overflow: hidden;
    border: 1px solid #2a2a4a;
}
table { width: 100%; border-collapse: collapse; }
th {
    text-align: left; padding: 10px 14px; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.5px; color: #666; background: #12122a;
    border-bottom: 1px solid #2a2a4a; position: sticky; top: 0;
}
td { padding: 8px 14px; border-bottom: 1px solid #1f1f3a; font-size: 14px; }
tr:hover { background: #1f1f3a; }
tr.skipped { opacity: 0.4; }
tr.skipped td { text-decoration: line-through; color: #555; }
.msg { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #888; font-size: 13px; }
.badge {
    display: inline-block; background: #e74c3c; color: #fff; border-radius: 10px;
    padding: 2px 8px; font-size: 11px; font-weight: 700; min-width: 20px; text-align: center;
}
input[type="checkbox"] {
    width: 18px; height: 18px; cursor: pointer; accent-color: #6c5ce7;
}
.stats {
    display: flex; gap: 20px; margin: 12px 0;
}
.stat-card {
    background: #1a1a2e; border-radius: 10px; padding: 14px 20px;
    border: 1px solid #2a2a4a; flex: 1;
}
.stat-card .num { font-size: 24px; font-weight: 700; color: #fff; }
.stat-card .label { font-size: 12px; color: #666; margin-top: 4px; }
.tag {
    display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 6px;
    background: #2a2a4a; color: #888; margin-left: 6px;
}
footer {
    text-align: center; padding: 20px; color: #444; font-size: 12px;
}
</style>
</head>
<body>

<div class="header">
    <div>
        <h1>📱 ForgeGrowth — Contact Selector</h1>
        <span>${data.contacts.length} total contacts</span>
    </div>
</div>

<div class="controls">
    <input type="text" id="search" placeholder="🔍 Search name or number..." oninput="filterTable()">
    <select id="filterDir" onchange="filterTable()">
        <option value="all">All directions</option>
        <option value="you">You sent last</option>
        <option value="them">They sent last</option>
    </select>
    <select id="filterDate" onchange="filterTable()">
        <option value="all">Any time</option>
        <option value="week">This week</option>
        <option value="month">This month</option>
        <option value="old">Older</option>
        <option value="never">Never messaged</option>
    </select>
    <button class="btn-outline" onclick="selectAll(true)">Select All</button>
    <button class="btn-outline" onclick="selectAll(false)">Deselect All</button>
    <button class="btn-outline" onclick="selectRecent()">Only Recent (7d)</button>
    <button class="btn-success" onclick="submitSelections()">📨 Save Selection</button>
</div>

<div class="stats">
    <div class="stat-card">
        <div class="num" id="selectedCount">${data.contacts.length}</div>
        <div class="label">Selected to contact</div>
    </div>
    <div class="stat-card">
        <div class="num" id="visibleCount">${data.contacts.length}</div>
        <div class="label">Visible</div>
    </div>
    <div class="stat-card">
        <div class="num" style="color:#e74c3c">${data.contacts.filter(c => c.unread > 0).length}</div>
        <div class="label">With unread messages</div>
    </div>
</div>

<div class="table-wrap">
    <table>
        <thead>
            <tr>
                <th style="width:40px">✓</th>
                <th>Name</th>
                <th>Number</th>
                <th>Last Activity</th>
                <th>Last Message</th>
                <th style="width:50px">!</th>
            </tr>
        </thead>
        <tbody id="contactsBody">
            ${rows}
        </tbody>
    </table>
</div>

<footer>
    ForgeGrowth Digital — Select who to contact about your SaaS. Click "Save Selection" when done.
</footer>

<script>
const contacts = ${JSON.stringify(data.contacts)};

function filterTable() {
    const q = document.getElementById('search').value.toLowerCase();
    const dir = document.getElementById('filterDir').value;
    const date = document.getElementById('filterDate').value;
    const rows = document.querySelectorAll('#contactsBody tr');
    let visible = 0;
    
    rows.forEach((row, i) => {
        const c = contacts[i];
        if (!c) return;
        
        let show = true;
        
        if (q && !c.name.toLowerCase().includes(q) && !c.number.includes(q)) show = false;
        
        if (dir === 'you' && !c.lastFromYou) show = false;
        if (dir === 'them' && c.lastFromYou) show = false;
        
        if (date === 'week' && (!c.lastDate || (Date.now() - new Date(c.lastDate).getTime()) > 7*86400000)) show = false;
        if (date === 'month' && (!c.lastDate || (Date.now() - new Date(c.lastDate).getTime()) > 30*86400000)) show = false;
        if (date === 'old' && c.lastDate && (Date.now() - new Date(c.lastDate).getTime()) < 30*86400000) show = false;
        if (date === 'never' && c.lastDate) show = false;
        if (date === 'never' && !c.lastDate) show = true;
        
        row.style.display = show ? '' : 'none';
        if (show) visible++;
    });
    
    document.getElementById('visibleCount').textContent = visible;
    updateSelectedCount();
}

function selectAll(val) {
    document.querySelectorAll('.select-contact').forEach(cb => cb.checked = val);
    updateSelectedCount();
}

function selectRecent() {
    document.querySelectorAll('.select-contact').forEach((cb, i) => {
        const c = contacts[i];
        cb.checked = c.lastDate && (Date.now() - new Date(c.lastDate).getTime()) < 7*86400000;
    });
    updateSelectedCount();
}

function updateSelectedCount() {
    const checked = document.querySelectorAll('.select-contact:checked').length;
    document.getElementById('selectedCount').textContent = checked;
}

function submitSelections() {
    const selected = [];
    const skipped = [];
    
    document.querySelectorAll('.select-contact').forEach((cb, i) => {
        const c = contacts[i];
        if (cb.checked) {
            selected.push(c);
        } else {
            skipped.push(c);
        }
    });
    
    const result = {
        selected: { count: selected.length, contacts: selected },
        skipped: { count: skipped.length, contacts: skipped },
        exportedAt: new Date().toISOString()
    };
    
    // Download as JSON
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'forgegrowth_contacts_selection.json';
    a.click();
    URL.revokeObjectURL(url);
    
    alert('✅ Saved!\n\nSelected: ' + selected.length + ' contacts to reach out to\nSkipped: ' + skipped.length + ' contacts');
}
</script>
</body>
</html>`;

const outPath = '/tmp/forgegrowth_contacts.html';
fs.writeFileSync(outPath, html);
console.log(`HTML saved to ${outPath}`);
console.log(`Total contacts embedded: ${data.contacts.length}`);

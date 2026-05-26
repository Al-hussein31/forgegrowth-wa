const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/wa_contacts.json', 'utf8'));

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function timeAgo(d) {
    if (!d) return 'Never';
    const diff = Date.now() - new Date(d).getTime();
    const m = Math.floor(diff/60000);
    if (m<60) return m+'m ago';
    const h = Math.floor(m/60);
    if (h<24) return h+'h ago';
    const days = Math.floor(h/24);
    if (days<30) return days+'d ago';
    return new Date(d).toLocaleDateString();
}

let rows = '';
data.contacts.forEach((c,i) => {
    const dir = c.lastFromYou ? '&#x1f4e4;' : '&#x1f4e5;';
    const unread = c.unread > 0 ? '<span class="b">'+c.unread+'</span>' : '';
    const date = timeAgo(c.lastDate);
    rows += '<tr><td><input type="checkbox" class="sel" data-idx="'+i+'" checked></td>'
        + '<td>'+esc(c.name)+'</td>'
        + '<td>'+esc(c.number)+'</td>'
        + '<td>'+dir+' '+date+'</td>'
        + '<td class="m">'+esc(c.lastText)+'</td>'
        + '<td>'+unread+'</td></tr>';
});

const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
+ '<title>ForgeGrowth Contact Selector</title>'
+ '<style>'
+ '*{margin:0;padding:0;box-sizing:border-box}'
+ 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f1a;color:#e0e0e0;padding:20px}'
+ '.hdr{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:#1a1a2e;border-radius:12px;margin-bottom:20px;border:1px solid #2a2a4a}'
+ '.hdr h1{font-size:20px;color:#fff}.hdr span{color:#888;font-size:14px}'
+ '.ctrl{display:flex;gap:12px;margin-bottom:16px;align-items:center;flex-wrap:wrap}'
+ '.ctrl input,.ctrl select{padding:8px 14px;border-radius:8px;border:1px solid #2a2a4a;background:#1a1a2e;color:#e0e0e0;font-size:14px}'
+ '.ctrl input::placeholder{color:#555}'
+ '.ctrl button{padding:8px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;transition:all .2s}'
+ '.p{background:#6c5ce7;color:#fff}.p:hover{background:#5a4bd1}'
+ '.g{background:#2ecc71;color:#fff}.g:hover{background:#27ae60}'
+ '.o{background:transparent;color:#888;border:1px solid #2a2a4a}.o:hover{border-color:#6c5ce7;color:#6c5ce7}'
+ '.w{background:#1a1a2e;border-radius:12px;overflow:hidden;border:1px solid #2a2a4a}'
+ 'table{width:100%;border-collapse:collapse}'
+ 'th{text-align:left;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#666;background:#12122a;border-bottom:1px solid #2a2a4a;position:sticky;top:0}'
+ 'td{padding:8px 14px;border-bottom:1px solid #1f1f3a;font-size:14px}'
+ 'tr:hover{background:#1f1f3a}'
+ '.m{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888;font-size:13px}'
+ '.b{display:inline-block;background:#e74c3c;color:#fff;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700;min-width:20px;text-align:center}'
+ 'input[type=checkbox]{width:18px;height:18px;cursor:pointer;accent-color:#6c5ce7}'
+ '.st{display:flex;gap:20px;margin:12px 0}'
+ '.sc{background:#1a1a2e;border-radius:10px;padding:14px 20px;border:1px solid #2a2a4a;flex:1}'
+ '.sc .n{font-size:24px;font-weight:700;color:#fff}.sc .l{font-size:12px;color:#666;margin-top:4px}'
+ 'footer{text-align:center;padding:20px;color:#444;font-size:12px}'
+ '</style></head><body>'
+ '<div class="hdr"><div><h1>📱 ForgeGrowth &mdash; Contact Selector</h1><span>'+data.contacts.length+' total contacts</span></div></div>'
+ '<div class="ctrl">'
+ '<input type="text" id="q" placeholder="🔍 Search name or number..." oninput="f()">'
+ '<select id="d" onchange="f()"><option value="all">All</option><option value="you">You sent last</option><option value="them">They sent last</option></select>'
+ '<select id="t" onchange="f()"><option value="all">Any time</option><option value="week">This week</option><option value="month">This month</option><option value="old">Older</option><option value="never">Never</option></select>'
+ '<button class="o" onclick="sa(true)">Select All</button>'
+ '<button class="o" onclick="sa(false)">Deselect All</button>'
+ '<button class="o" onclick="s7()">Only 7d</button>'
+ '<button class="g" onclick="sub()">📨 Save Selection</button>'
+ '</div>'
+ '<div class="st"><div class="sc"><div class="n" id="sc">'+data.contacts.length+'</div><div class="l">Selected</div></div>'
+ '<div class="sc"><div class="n" id="vc">'+data.contacts.length+'</div><div class="l">Visible</div></div>'
+ '<div class="sc"><div class="n" style="color:#e74c3c">'+data.contacts.filter(c=>c.unread>0).length+'</div><div class="l">With unread</div></div></div>'
+ '<div class="w"><table><thead><tr><th style="width:40px">✓</th><th>Name</th><th>Number</th><th>Activity</th><th>Last Message</th><th style="width:50px">!</th></tr></thead><tbody>'
+ rows
+ '</tbody></table></div>'
+ '<footer>ForgeGrowth Digital &mdash; Select contacts to message. Click Save when done.</footer>'
+ '<script>'
+ 'var C='+JSON.stringify(data.contacts)+';'
+ 'function f(){var q=document.getElementById("q").value.toLowerCase(),di=document.getElementById("d").value,ti=document.getElementById("t").value;var rows=document.querySelectorAll("#contactsBody tr"),vis=0;rows.forEach(function(r,i){var c=C[i];if(!c)return;var s=true;if(q&&!c.name.toLowerCase().includes(q)&&!c.number.includes(q))s=false;if(di=="you"&&!c.lastFromYou)s=false;if(di=="them"&&c.lastFromYou)s=false;var n=Date.now();if(ti=="week"&&(!c.lastDate||(n-new Date(c.lastDate).getTime())>7*86400000))s=false;if(ti=="month"&&(!c.lastDate||(n-new Date(c.lastDate).getTime())>30*86400000))s=false;if(ti=="old"&&c.lastDate&&(n-new Date(c.lastDate).getTime())<30*86400000)s=false;if(ti=="never"&&c.lastDate)s=false;r.style.display=s?"":"none";if(s)vis++});document.getElementById("vc").textContent=vis;u();}'
+ 'function sa(v){document.querySelectorAll(".sel").forEach(function(cb){cb.checked=v});u();}'
+ 'function s7(){document.querySelectorAll(".sel").forEach(function(cb,i){var c=C[i];cb.checked=c.lastDate&&(Date.now()-new Date(c.lastDate).getTime())<7*86400000});u();}'
+ 'function u(){var c=document.querySelectorAll(".sel:checked").length;document.getElementById("sc").textContent=c;}'
+ 'function sub(){var sel=[],skip=[];document.querySelectorAll(".sel").forEach(function(cb,i){if(cb.checked)sel.push(C[i]);else skip.push(C[i])});var r={selected:{count:sel.length,contacts:sel},skipped:{count:skip.length,contacts:skip},exportedAt:new Date().toISOString()};var blob=new Blob([JSON.stringify(r,null,2)],{type:"application/json"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="forgegrowth_selection.json";a.click();alert("Saved!\\nSelected: "+sel.length+"\\nSkipped: "+skip.length);}'
+ '</script></body></html>';

const out = '/tmp/forgegrowth_contacts.html';
fs.writeFileSync(out, html);
console.log('DONE: '+out);
console.log('Contacts: '+data.contacts.length);

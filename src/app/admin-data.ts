export const DATA_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyBot · 数据</title>
<style>
:root{
  color-scheme:light dark;
  --bg:#f4f5f7;--fg:#171a1f;--muted:#68707c;--line:#dfe3e9;--card:#ffffff;
  --soft:#f7f8fa;--accent:#3056d3;--danger:#b42318;
}
@media(prefers-color-scheme:dark){
  :root{--bg:#0d1015;--fg:#e7eaf0;--muted:#99a2ae;--line:#262c36;--card:#151a22;--soft:#10151c;--accent:#7c9cff;--danger:#ff8a80}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}
.top{max-width:1160px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:16px;margin:0}
.sub{font-size:12px;color:var(--muted)}
main{max-width:1160px;margin:0 auto;padding:20px 24px 60px}
.tabs{display:flex;gap:8px;margin:0 0 16px;flex-wrap:wrap}
.toolbar{display:flex;justify-content:flex-end;margin:0 0 10px}
.toolbar[hidden]{display:none}
.tab{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:999px;padding:7px 14px;font:inherit;cursor:pointer}
.tab.on{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--line));background:color-mix(in srgb,var(--accent) 8%,transparent)}
.panel{border:1px solid var(--line);background:var(--card);border-radius:14px;overflow:hidden}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:760px}
th,td{padding:9px 11px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:500;background:var(--soft);white-space:nowrap}
tr:last-child td{border-bottom:0}
.thumb{width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:var(--soft)}
.muted{color:var(--muted)}
.tag{display:inline-block;padding:1px 7px;margin:1px 3px 1px 0;border:1px solid var(--line);border-radius:999px;font-size:11px;color:var(--muted)}
.btn{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:8px;padding:5px 10px;font:inherit;cursor:pointer}
.btn:hover{color:var(--fg)}
.btn.danger:hover{color:var(--danger);border-color:var(--danger)}
.link{color:var(--accent);text-decoration:none;font-size:12.5px}
.status{font-size:12px;color:var(--muted);margin:10px 2px}
.status.error{color:var(--danger)}
.empty{padding:40px;text-align:center;color:var(--muted)}
.editor{position:fixed;inset:0;z-index:20;background:rgba(10,15,30,.45);display:grid;place-items:center;padding:20px}
.editor[hidden]{display:none}
.editor .card{width:min(620px,100%);max-height:calc(100vh - 40px);overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;box-shadow:0 24px 60px rgba(0,0,0,.28)}
.editor h2{font-size:16px;margin:0 0 12px}
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;font-size:12px;color:var(--muted)}
.field input,.field textarea,.field select{width:100%;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--fg);font:inherit;padding:8px 10px}
.field textarea{min-height:70px;resize:vertical}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.actions .primary{border:0;border-radius:9px;padding:8px 16px;font:inherit;color:#fff;background:var(--accent);cursor:pointer}
.actions .ghost{border:1px solid var(--line);border-radius:9px;padding:8px 16px;font:inherit;color:var(--muted);background:transparent;cursor:pointer}
</style>
</head>
<body>
<header><div class="top"><div><h1>MyBot 数据</h1><div class="sub">图片 / 梗 / 记忆</div></div><a class="link" href="/admin" style="margin-left:auto">返回配置</a></div></header>
<main>
  <div class="tabs">
    <button class="tab on" data-tab="images">图片</button>
    <button class="tab" data-tab="memes">梗</button>
    <button class="tab" data-tab="memories">记忆</button>
  </div>
  <div class="toolbar" id="toolbar" hidden><button class="btn" type="button" id="upload-image">上传图片</button></div>
  <div class="panel"><div class="scroll" id="table"></div></div>
  <div class="status" id="status"></div>
</main>
<div class="editor" id="image-editor" hidden>
  <form class="card" id="image-form">
    <h2>编辑图片</h2>
    <div class="field"><span>分类</span><select id="image-category"><option value="sticker">sticker</option><option value="meme">meme</option><option value="image">image（只限已有群的普通图）</option></select></div>
    <div class="field"><span>描述</span><input id="image-caption"></div>
    <div class="field"><span>情绪</span><input id="image-emotion"></div>
    <div class="field"><span>标签，逗号分隔</span><input id="image-tags"></div>
    <div class="actions"><button class="ghost" type="button" id="image-cancel">取消</button><button class="primary" type="submit">保存</button></div>
  </form>
</div>
<div class="editor" id="upload-editor" hidden>
  <form class="card" id="upload-form">
    <h2>上传图片</h2>
    <div class="field"><span>文件</span><input id="upload-file" type="file" accept="image/*"></div>
    <div class="row">
      <div class="field"><span>分类</span><select id="upload-category"><option value="sticker">sticker</option><option value="meme">meme</option></select></div>
      <div class="field"><span>情绪</span><input id="upload-emotion"></div>
    </div>
    <div class="field"><span>描述</span><input id="upload-caption"></div>
    <div class="field"><span>标签，逗号分隔</span><input id="upload-tags"></div>
    <div class="actions"><button class="ghost" type="button" id="upload-cancel">取消</button><button class="primary" type="submit">上传</button></div>
  </form>
</div>
<div class="editor" id="editor" hidden>
  <form class="card" id="edit-form">
    <h2>编辑梗</h2>
    <div class="field"><span>关键词</span><input id="edit-keyword" readonly></div>
    <div class="field"><span>标题</span><input id="edit-title"></div>
    <div class="field"><span>含义</span><textarea id="edit-meaning"></textarea></div>
    <div class="field"><span>回复方式</span><textarea id="edit-reply"></textarea></div>
    <div class="field"><span>别名，逗号分隔</span><input id="edit-aliases"></div>
    <div class="field"><span>标签，逗号分隔</span><input id="edit-tags"></div>
    <div class="field"><span>示例，每行一条：输入 =&gt; 回复</span><textarea id="edit-examples"></textarea></div>
    <div class="row">
      <div class="field"><span>热度 1-5</span><input id="edit-heat" type="number" min="1" max="5"></div>
      <div class="field"><span>状态</span><select id="edit-status"><option value="active">active</option><option value="outdated">outdated</option></select></div>
    </div>
    <div class="actions"><button class="ghost" type="button" id="edit-cancel">取消</button><button class="primary" type="submit">保存</button></div>
  </form>
</div>
<script>
var tab = 'images';
var table = document.querySelector('#table');
var statusEl = document.querySelector('#status');

function text(value){ return value == null ? '' : String(value); }
function date(value){ return value ? new Date(value).toLocaleString('zh-CN') : ''; }
function tags(values){
  var box = document.createElement('span');
  (values || []).forEach(function(value){
    var tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = value; box.append(tag);
  });
  return box;
}
function cell(row, value){
  var td = document.createElement('td');
  if(value instanceof Node) td.append(value); else td.textContent = text(value);
  row.append(td);
  return td;
}
function button(label, handler){
  var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn danger'; btn.textContent = label;
  btn.onclick = handler; return btn;
}
function editButton(handler){
  var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; btn.textContent = '编辑';
  btn.onclick = handler; return btn;
}
function tableEl(headers){
  var table = document.createElement('table');
  var head = document.createElement('tr');
  headers.forEach(function(name){ var th = document.createElement('th'); th.textContent = name; head.append(th); });
  table.append(head);
  return table;
}
function show(rows, build){
  table.innerHTML = '';
  if(!rows.length){ var empty = document.createElement('div'); empty.className='empty'; empty.textContent='没有数据'; table.append(empty); return; }
  table.append(build(rows));
}
function renderImages(rows){
  var el = tableEl(['图片','ID','分类','描述','标签','群','使用','创建','过期','操作']);
  rows.forEach(function(item){
    var tr = document.createElement('tr');
    var img = document.createElement('img'); img.className='thumb'; img.loading='lazy'; img.src='/api/images/' + item.id + '/content'; img.alt='';
    var actions = document.createElement('span');
    actions.append(editButton(function(){ openImageEdit(item); }), document.createTextNode(' '), button('删除', function(){ removeImage(item.id).catch(fail); }));
    cell(tr, img); cell(tr, item.id); cell(tr, item.category); cell(tr, item.caption || ''); cell(tr, tags(item.tags));
    cell(tr, item.conversationId || '全局'); cell(tr, item.useCount); cell(tr, date(item.createdAt)); cell(tr, item.expiresAt ? date(item.expiresAt) : '永久');
    cell(tr, actions);
    el.append(tr);
  });
  return el;
}
function renderMemes(rows){
  var el = tableEl(['关键词','标题','含义','回复方式','标签','热度','状态','使用','更新','操作']);
  rows.forEach(function(item){
    var tr = document.createElement('tr');
    var actions = document.createElement('span');
    actions.append(editButton(function(){ openEdit(item); }), document.createTextNode(' '), button('删除', function(){ removeMeme(item.keyword).catch(fail); }));
    cell(tr, item.keyword); cell(tr, item.title); cell(tr, item.meaning); cell(tr, item.replyGuide); cell(tr, tags(item.tags));
    cell(tr, item.heat + '/5'); cell(tr, item.status); cell(tr, item.useCount); cell(tr, date(item.updatedAt)); cell(tr, actions);
    el.append(tr);
  });
  return el;
}
function renderMemories(rows){
  var el = tableEl(['时间','类型','重要度','内容','标签','过期']);
  rows.forEach(function(item){
    var tr = document.createElement('tr');
    cell(tr, date(item.createdAt)); cell(tr, item.kind); cell(tr, item.importance + '/5'); cell(tr, item.content);
    cell(tr, tags(item.tags)); cell(tr, item.expiresAt ? date(item.expiresAt) : '永久');
    el.append(tr);
  });
  return el;
}
var editing = null;
var editor = document.querySelector('#editor');
var form = document.querySelector('#edit-form');
function listText(values){ return (values || []).join(', '); }
function parseList(value){ return value.split(/[,，]/).map(function(item){ return item.trim(); }).filter(Boolean); }
function examplesText(values){
  return (values || []).map(function(item){ return item.input + ' => ' + item.reply; }).join('\\n');
}
function parseExamples(value){
  var items = [];
  value.split('\\n').forEach(function(line){
    var at = line.indexOf('=>');
    if(at < 0) return;
    var input = line.slice(0, at).trim(); var reply = line.slice(at + 2).trim();
    if(input && reply) items.push({input: input, reply: reply});
  });
  return items;
}
function openEdit(item){
  editing = item;
  document.querySelector('#edit-keyword').value = item.keyword;
  document.querySelector('#edit-title').value = item.title || '';
  document.querySelector('#edit-meaning').value = item.meaning || '';
  document.querySelector('#edit-reply').value = item.replyGuide || '';
  document.querySelector('#edit-aliases').value = listText(item.aliases);
  document.querySelector('#edit-tags').value = listText(item.tags);
  document.querySelector('#edit-examples').value = examplesText(item.examples);
  document.querySelector('#edit-heat').value = item.heat;
  document.querySelector('#edit-status').value = item.status;
  editor.hidden = false;
}
function closeEdit(){ editor.hidden = true; editing = null; }
document.querySelector('#edit-cancel').onclick = closeEdit;
form.onsubmit = async function(event){
  event.preventDefault();
  if(!editing) return;
  var payload = {
    keyword: editing.keyword,
    title: document.querySelector('#edit-title').value,
    meaning: document.querySelector('#edit-meaning').value,
    replyGuide: document.querySelector('#edit-reply').value,
    aliases: parseList(document.querySelector('#edit-aliases').value),
    tags: parseList(document.querySelector('#edit-tags').value),
    examples: parseExamples(document.querySelector('#edit-examples').value),
    heat: Number(document.querySelector('#edit-heat').value),
    status: document.querySelector('#edit-status').value
  };
  var res = await fetch('/api/data/memes', {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
  });
  if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
  var data = await res.json();
  if(!res.ok){ fail(new Error(data.error || '保存失败')); return; }
  closeEdit(); await load();
};

var toolbar = document.querySelector('#toolbar');
var imageEditor = document.querySelector('#image-editor');
var uploadEditor = document.querySelector('#upload-editor');
var imageEditing = null;
function openImageEdit(item){
  imageEditing = item;
  document.querySelector('#image-category').value = item.category;
  document.querySelector('#image-caption').value = item.caption || '';
  document.querySelector('#image-emotion').value = item.emotion || '';
  document.querySelector('#image-tags').value = listText(item.tags);
  imageEditor.hidden = false;
}
function closeImageEdit(){ imageEditor.hidden = true; imageEditing = null; }
document.querySelector('#image-cancel').onclick = closeImageEdit;
document.querySelector('#image-form').onsubmit = async function(event){
  event.preventDefault();
  if(!imageEditing) return;
  var res = await fetch('/api/data/images', {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      id: imageEditing.id,
      category: document.querySelector('#image-category').value,
      caption: document.querySelector('#image-caption').value,
      emotion: document.querySelector('#image-emotion').value,
      tags: parseList(document.querySelector('#image-tags').value)
    })
  });
  if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
  var data = await res.json();
  if(!res.ok){ fail(new Error(data.error || '保存失败')); return; }
  closeImageEdit(); await load();
};

function closeUpload(){ uploadEditor.hidden = true; }
document.querySelector('#upload-image').onclick = function(){ uploadEditor.hidden = false; };
document.querySelector('#upload-cancel').onclick = closeUpload;
document.querySelector('#upload-form').onsubmit = function(event){
  event.preventDefault();
  var file = document.querySelector('#upload-file').files[0];
  if(!file){ fail(new Error('先选一张图片')); return; }
  if(file.size > 10 * 1024 * 1024){ fail(new Error('图片不能超过 10MB')); return; }
  var reader = new FileReader();
  reader.onload = async function(){
    var result = String(reader.result || '');
    var comma = result.indexOf(',');
    var encoded = comma >= 0 ? result.slice(comma + 1) : '';
    var res = await fetch('/api/data/images', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        mime: file.type || 'image/png',
        data: encoded,
        category: document.querySelector('#upload-category').value,
        caption: document.querySelector('#upload-caption').value,
        emotion: document.querySelector('#upload-emotion').value,
        tags: parseList(document.querySelector('#upload-tags').value)
      })
    });
    if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
    var data = await res.json();
    if(!res.ok){ fail(new Error(data.error || '上传失败')); return; }
    closeUpload(); await load();
    statusEl.className = 'status ok';
    statusEl.textContent = data.duplicate ? '图片已存在，没有重复写入' : '上传成功';
  };
  reader.onerror = function(){ fail(new Error('读取文件失败')); };
  reader.readAsDataURL(file);
};

async function load(){
  toolbar.hidden = tab !== 'images';
  statusEl.className = 'status'; statusEl.textContent = '加载中…';
  var res = await fetch('/api/data/' + tab);
  if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
  var data = await res.json();
  if(!res.ok) throw new Error(data.error || '读取失败');
  if(tab === 'images') show(data.items, renderImages);
  if(tab === 'memes') show(data.items, renderMemes);
  if(tab === 'memories') show(data.items, renderMemories);
  statusEl.textContent = tab === 'memories' ? '记忆只读，没有用户删除入口' : '';
}
async function removeImage(id){
  if(!confirm('删除图片 #' + id + '？')) return;
  var res = await fetch('/api/data/images?id=' + id, {method:'DELETE'});
  if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
  var data = await res.json();
  if(!res.ok) throw new Error(data.error || '删除失败');
  load().catch(fail);
}
async function removeMeme(keyword){
  if(!confirm('删除梗：' + keyword + '？')) return;
  var res = await fetch('/api/data/memes?keyword=' + encodeURIComponent(keyword), {method:'DELETE'});
  if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
  var data = await res.json();
  if(!res.ok) throw new Error(data.error || '删除失败');
  load().catch(fail);
}
function fail(error){ statusEl.className = 'status error'; statusEl.textContent = error.message; }
document.querySelectorAll('.tab').forEach(function(btn){
  btn.onclick = function(){
    tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(function(other){ other.classList.toggle('on', other === btn); });
    load().catch(fail);
  };
});
load().catch(fail);
</script>
</body>
</html>`;

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body {
  font-family: 'DM Sans', system-ui, sans-serif;
  background: #161B29;
  color: #E8EAF0;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
button { font-family: inherit; cursor: pointer; }
input, select, textarea { font-family: inherit; }

.btn {
  border: none; border-radius: 8px; padding: 9px 16px;
  font-size: 14px; font-weight: 600; color: #fff; background: #4A7CFF;
}
.btn-ghost { background: transparent; border: 1px solid rgba(255,255,255,0.12); color: #E8EAF0; }
.btn:disabled { opacity: .5; cursor: not-allowed; }

.input {
  width: 100%; background: #1B212E; border: 1px solid rgba(255,255,255,0.10);
  border-radius: 8px; padding: 9px 11px; color: #E8EAF0; font-size: 14px;
}
label { display: block; font-size: 12px; color: #9BA3BC; margin-bottom: 4px; }
table { width: 100%; border-collapse: collapse; }

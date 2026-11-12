// [raw-sockets project] RAWLINK: the browser end of the localhost WebSocket to bridge/bridge.js,
// plus a DOM overlay for login/register, lobby (room list, create/join/leave), room status with
// pings, live scoreboard, final results, connection-lost banner and an F3 network HUD.
// Loaded only when the page is served by the bridge (window.RAW_BRIDGE is defined).
var RAWCODE={HELLO:20,WELCOME:21,REGISTER:22,LOGIN:23,AUTH_OK:24,AUTH_FAIL:25,ROOM_LIST_REQ:26,ROOM_LIST:27,CREATE_ROOM:28,
	PLAYER_LEFT:29,PLAYER_DROPPED:30,SCORE_EVENT:31,SCOREBOARD:32,GAME_RESULT:33,PING:34,PONG:35,ERROR:36,BYE:37,
	GAME_END_REQ:38,LOGOUT:39,HOST_CHANGED:40,ROOM_JOINED:41,SESSION_STATUS:42};
var RAWLINK=null;

(function(){
	if (!window.RAW_BRIDGE) return;

	var css=`
	#rawov{position:fixed;inset:0;z-index:50;font:20px/1.35 system-ui,Segoe UI,Arial,sans-serif;color:#f4f4f4;pointer-events:none}
	#rawov .full{position:absolute;inset:0;background:rgba(8,10,20,.92);display:flex;align-items:center;justify-content:center;pointer-events:auto}
	#rawov .card{background:#161a2b;border:2px solid #3b4470;border-radius:14px;padding:26px 32px;min-width:520px;max-width:92vw;max-height:90vh;overflow:auto;box-shadow:0 10px 40px #000}
	#rawov h1{margin:0 0 6px;font-size:32px;letter-spacing:1px}
	#rawov h2{margin:16px 0 8px;font-size:24px}
	#rawov .sub{color:#9aa3c7;font-size:17px;margin-bottom:16px}
	#rawov input{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #556;background:#0d1020;color:#fff;width:220px;margin:4px 8px 4px 0}
	#rawov button{font:inherit;font-weight:600;padding:8px 18px;border-radius:8px;border:0;background:#3d6bff;color:#fff;cursor:pointer;margin:4px 6px 4px 0}
	#rawov button.alt{background:#39405e}#rawov button.red{background:#d2404d}#rawov button:disabled{opacity:.4}
	#rawov table{border-collapse:collapse;width:100%;font-size:19px}
	#rawov td,#rawov th{padding:6px 10px;border-bottom:1px solid #2c3352;text-align:left}
	#rawov .err{color:#ff7b86;min-height:26px;margin-top:8px;font-weight:600}
	#rawov .ok{color:#7dffa8}
	#rawov .tag{display:inline-block;padding:1px 9px;border-radius:6px;font-size:15px;font-weight:700;background:#2f3a66}
	#rawov .waiting{background:#245c3a}#rawov .playing{background:#7a4b16}
	#rawov .side{position:absolute;top:10px;right:10px;width:340px;background:rgba(14,17,32,.88);border:2px solid #3b4470;border-radius:12px;padding:12px 14px;pointer-events:auto;font-size:17px}
	#rawov .side h3{margin:0 0 6px;font-size:20px}
	#rawov .banner{position:absolute;top:0;left:0;right:0;padding:12px;text-align:center;font-weight:800;font-size:24px;background:#c8323f;pointer-events:none}
	#rawov .toast{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);background:#222a48;border:2px solid #5468b8;border-radius:10px;padding:10px 20px;font-weight:600;pointer-events:none}
	#rawov .hud{position:absolute;left:10px;bottom:10px;background:rgba(0,0,0,.8);font:15px/1.3 Consolas,monospace;padding:10px 12px;border-radius:8px;white-space:pre;pointer-events:none;color:#9f9}
	#rawov .win{font-size:40px;font-weight:900;color:#ffd84a;margin:6px 0 12px}
	#rawov .proto{font-weight:900;color:#ffd84a}`;
	var st=document.createElement("style"); st.textContent=css; document.head.appendChild(st);

	var ov, ws, handlers={}, toastTimer, lastToast="";
	var S={link:"connecting",linkInfo:{},user:null,rooms:[],view:"login",status:null,scoreboard:null,result:null,
		err:"",inNetplayScreen:false,inGame:false,hud:false,stats:null,currentRoom:null};

	function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

	RAWLINK={
		loggedIn:false,
		on:function(t,fn){ (handlers[t]=handlers[t]||[]).push(fn); },
		send:function(t,d){ if (ws&&ws.readyState==1) ws.send(JSON.stringify({t:t,d:d})); },
		metric:function(k,v){ if (ws&&ws.readyState==1) ws.send(JSON.stringify({t:"metric",k:k,v:v})); },
		onNetplayScreen:function(on){ S.inNetplayScreen=on; if (!on) { S.inGame=false; S.currentRoom=null; S.status=null; S.view=RAWLINK.loggedIn?"lobby":"login"; RAWLINK.send(RAWCODE.ROOM_LIST_REQ); } render(); },
		onGameStart:function(){ S.inGame=true; S.result=null; S.scoreboard=null; render(); },
		// --- hooks called from game.js / netplay.js (minimal edits there)
		reportDeath:function(victimNetId,killerNetId,isFrag){
			RAWLINK.send(RAWCODE.SCORE_EVENT,{kind:isFrag?"kill":"suicide",victim:victimNetId,killer:killerNetId||null});
		},
		reportGameEnd:function(){ RAWLINK.send(RAWCODE.GAME_END_REQ,{}); },
		noteCorrection:function(dist){ if (dist>0.5) RAWLINK.metric("desync",dist); }
	};

	function dispatch(m){
		var hs=handlers[m.t]; if (hs) hs.forEach(h=>{ try { h(m.d); } catch(e){ console.error(e); } });
	}

	function toast(text){
		lastToast=text; clearTimeout(toastTimer);
		toastTimer=setTimeout(()=>{ lastToast=""; render(); },3500); render();
	}

	function connect(){
		ws=new WebSocket("ws://"+location.host+RAW_BRIDGE.ws);
		ws.onmessage=function(e){
			var m; try { m=JSON.parse(e.data); } catch(x){ return; }
			if (m.t==="link") {
				var was=S.link; S.link=m.state; S.linkInfo=m;
				if (m.state==="down") { RAWLINK.loggedIn=false; }
				render(); return;
			}
			if (m.t==="stats") { S.stats=m; if (S.hud) render(); return; }
			dispatch(m);
		};
		ws.onclose=function(){ S.link="bridge"; render(); setTimeout(connect,1500); };
	}

	// ---- protocol handlers (UI side)
	RAWLINK.on(RAWCODE.AUTH_OK,function(d){
		RAWLINK.loggedIn=true; S.user=d.user; S.err="";
		RAWLINK.user=d.user;
		if (!S.inNetplayScreen) S.view="lobby";
		render();
	});
	RAWLINK.on(RAWCODE.AUTH_FAIL,function(d){ S.err=d.msg; render(); });
	RAWLINK.on(RAWCODE.ROOM_LIST,function(d){ S.rooms=d; render(); });
	RAWLINK.on(RAWCODE.ERROR,function(d){
		if (d.code==="roomPlaying"||d.code==="errorRoomFrozen") { if (lastToast!==d.msg) toast(d.msg); }
		else toast(d.msg||d.code);
		if (d.code==="replaced") { RAWLINK.loggedIn=false; S.user=null; S.view="login"; render(); }
	});
	RAWLINK.on(RAWCODE.ROOM_JOINED,function(d){ S.currentRoom=d.room; render(); });
	RAWLINK.on(RAWCODE.SESSION_STATUS,function(d){ S.status=d; render(); });
	RAWLINK.on(RAWCODE.SCOREBOARD,function(d){ S.scoreboard=d; render(); });
	RAWLINK.on(RAWCODE.GAME_RESULT,function(d){ S.result=d; S.inGame=false; render(); });
	RAWLINK.on(RAWCODE.PLAYER_DROPPED,function(d){ toast("⚠ "+d.user+" DISCONNECTED ("+d.reason+(d.detectMs?", detected after "+d.detectMs+" ms":"")+")"); });
	RAWLINK.on(RAWCODE.PLAYER_LEFT,function(d){ toast(d.user+" left the room"); });
	RAWLINK.on(RAWCODE.HOST_CHANGED,function(d){ toast("New host: "+d.user); });

	setInterval(function(){ if (RAWLINK.loggedIn&&!S.inNetplayScreen) RAWLINK.send(RAWCODE.ROOM_LIST_REQ); },2000);

	// ---- actions
	function doAuth(register){
		var u=document.getElementById("rawUser").value.trim(), p=document.getElementById("rawPass").value;
		if (!/^[A-Za-z0-9]{3,10}$/.test(u)) { S.err="Username: 3-10 letters/digits"; return render(); }
		if (p.length<3) { S.err="Password: at least 3 characters"; return render(); }
		S.err=""; RAWLINK.send(register?RAWCODE.REGISTER:RAWCODE.LOGIN,{user:u,pass:p});
		// start the PvP engine behind the overlay (its "Play" cover button) within this user gesture (audio unlock)
		var pb=document.getElementById("playbutton"); if (pb&&pb.parentNode) pb.click();
	}
	function engineReady(){ return window.CONFIG&&window.NETPLAY&&NETPLAY.isAvailable&&window.GAMESTATE&&GAMESTATE.goTo; }
	function joinRoom(id){
		S.currentRoom=id; S.result=null; RAWLINK.room=id;
		S.inNetplayScreen=true; render();
		var tries=0;
		(function go(){
			if (!engineReady()) {
				var pb=document.getElementById("playbutton"); if (pb&&pb.parentNode) pb.click();
				if (++tries>150) { toast("Game engine did not start - reload the page"); RAWLINK.onNetplayScreen(false); return; }
				return setTimeout(go,200);
			}
			CONFIG.netRoom=id;
			CONFIG.netNickname=(RAWLINK.user||"").toUpperCase().substr(0,10);
			setTimeout(function(){ GAMESTATE.goTo(GAMESTATE_NETPLAY); },tries?800:0);
		})();
	}
	function createRoom(){
		var n=document.getElementById("rawRoom").value.trim().toUpperCase();
		if (!/^[A-Z0-9]{3,8}$/.test(n)) { toast("Room name: 3-8 letters/digits"); return; }
		RAWLINK.send(RAWCODE.CREATE_ROOM,{name:n});
		var once=function(list){ if (list.some(r=>r.id===n)) { joinRoom(n); } };
		pendingCreate=once;
	}
	var pendingCreate=null;
	RAWLINK.on(RAWCODE.ROOM_LIST,function(list){ if (pendingCreate) { var f=pendingCreate; pendingCreate=null; f(list); } });
	function leaveRoom(){ if (S.inNetplayScreen&&window.NETPLAY&&NETPLAY.quit) NETPLAY.quit(); else RAWLINK.onNetplayScreen(false); }

	// ---- rendering
	function linkLine(){
		var i=S.linkInfo||{};
		return 'Transport: <span class="proto">raw '+esc(RAW_BRIDGE.proto)+'</span> &nbsp;·&nbsp; server '+esc(RAW_BRIDGE.server)+
			(S.stats&&S.stats.rtt!=null?' &nbsp;·&nbsp; ping '+S.stats.rtt+' ms':'');
	}

	function render(){
		if (!ov) return;
		var h="";
		if (S.link!=="up") {
			var msg=S.link==="bridge"?"Bridge process not reachable - is bridge.js running?":
				S.link==="down"?"CONNECTION TO SERVER LOST ("+esc(S.linkInfo.reason)+") - reconnecting...":"Connecting to "+esc(RAW_BRIDGE.server)+" over raw "+esc(RAW_BRIDGE.proto)+"...";
			if (S.inGame||S.inNetplayScreen) h+='<div class="banner">'+msg+'</div>';
			else h+='<div class="full"><div class="card"><h1>PvP Arena</h1><div class="sub">'+linkLine()+'</div><h2>'+msg+'</h2></div></div>';
		} else if (S.result) {
			var r=S.result;
			h+='<div class="full"><div class="card"><h1>Game over</h1><div class="sub">Room '+esc(r.room)+' · '+esc({scoreLimit:"score limit reached",notEnoughPlayers:"not enough players left",gameOver:"game ended"}[r.reason]||r.reason)+' · '+Math.round(r.durationMs/1000)+' s · '+linkLine()+'</div>';
			h+='<div class="win">'+(r.winner?"🏆 WINNER: "+esc(r.winner):(r.draw?"DRAW":"No winner"))+'</div>';
			h+='<table><tr><th>#</th><th>Player</th><th>Score</th><th>Kills</th><th>Deaths</th><th></th></tr>';
			r.ranking.forEach(p=>{ h+='<tr><td>'+p.rank+'</td><td>'+esc(p.user)+(p.user===S.user?' (you)':'')+'</td><td>'+p.score+'</td><td>'+p.kills+'</td><td>'+p.deaths+'</td><td>'+(p.left?esc(p.left==="left"?"left":"disconnected ("+p.left+")"):'')+'</td></tr>'; });
			h+='</table><br><button id="rawResOk">Back to room</button> <button class="alt" id="rawResLobby">Back to lobby</button></div></div>';
		} else if (!RAWLINK.loggedIn) {
			h+='<div class="full"><div class="card"><h1>PvP Arena</h1><div class="sub">'+linkLine()+'</div>'+
				'<h2>Login or register</h2><input id="rawUser" placeholder="username" maxlength="10" autocomplete="username"><input id="rawPass" type="password" placeholder="password" autocomplete="current-password"><br>'+
				'<button id="rawLogin">Login</button><button class="alt" id="rawRegister">Register</button><div class="err">'+esc(S.err)+'</div></div></div>';
		} else if (!S.inNetplayScreen) {
			h+='<div class="full"><div class="card"><h1>Lobby</h1><div class="sub">Logged in as <b>'+esc(S.user)+'</b> &nbsp;·&nbsp; '+linkLine()+'</div>';
			h+='<table><tr><th>Room</th><th>Players</th><th>Status</th><th>Host</th><th></th></tr>';
			if (!S.rooms.length) h+='<tr><td colspan=5 style="color:#9aa3c7">No rooms yet - create one!</td></tr>';
			S.rooms.forEach(r=>{
				h+='<tr><td><b>'+esc(r.name)+'</b></td><td>'+r.players+'/'+r.max+(r.users&&r.users.length?' <span style="color:#9aa3c7">('+r.users.map(esc).join(", ")+')</span>':'')+'</td><td><span class="tag '+r.status+'">'+r.status+'</span></td><td>'+esc(r.host||"-")+'</td>'+
					'<td><button data-join="'+esc(r.id)+'" '+(r.status!=="waiting"||r.players>=r.max?"disabled":"")+'>Join</button></td></tr>';
			});
			h+='</table><h2>Create a room</h2><input id="rawRoom" placeholder="ROOM NAME" maxlength="8"><button id="rawCreate">Create &amp; join</button>'+
				'<br><br><button class="alt" id="rawLogout">Logout</button> <span style="color:#9aa3c7;font-size:15px">F3: network stats</span></div></div>';
		} else {
			// side panel over the PvP netplay screen / the game
			var s=S.status;
			h+='<div class="side"><h3>Room '+esc(S.currentRoom||CONFIG.netRoom)+' '+(s?'<span class="tag '+s.status+'">'+s.status+'</span>':'')+'</h3>';
			h+='<div style="color:#9aa3c7;font-size:14px">'+linkLine()+'</div>';
			if (s) {
				h+='<table>'; s.players.forEach(p=>{ h+='<tr><td>'+(p.host?'👑 ':'')+esc(p.user)+(p.user===S.user?' (you)':'')+'</td><td>'+(s.status==="waiting"?(p.ready?'<span class="ok">ready</span>':'not ready'):'')+'</td><td>'+(p.ping!=null?p.ping+' ms':'')+'</td></tr>'; }); h+='</table>';
			}
			if (S.inGame&&S.scoreboard) {
				h+='<h3 style="margin-top:8px">Scoreboard'+(S.scoreboard.scoreLimit?' (to '+S.scoreboard.scoreLimit+')':'')+'</h3><table>';
				S.scoreboard.ranking.forEach(p=>{ h+='<tr><td>'+p.rank+'.</td><td>'+esc(p.user)+'</td><td>'+p.score+' pts</td><td>'+p.kills+'K/'+p.deaths+'D</td></tr>'; });
				h+='</table>';
			}
			if (!S.inGame) h+='<div style="font-size:14px;color:#9aa3c7;margin-top:6px">Hold FIRE to get ready. The 👑 host starts when everyone (≥2) is ready.</div><button class="red" id="rawLeave">Leave room</button>';
			h+='</div>';
		}
		if (lastToast) h+='<div class="toast">'+esc(lastToast)+'</div>';
		if (S.hud&&S.stats) {
			var x=S.stats, c=x.c||{}, rs=x.rttStats||{};
			h+='<div class="hud">'+esc(
				"NET "+x.proto+" -> "+x.server+"\n"+
				"RTT now "+x.rtt+" ms  min/avg/p95/max "+rs.min+"/"+rs.avg+"/"+rs.p95+"/"+rs.max+"  jitter "+x.jitter+"\n"+
				"msgs out/in "+(c.msgsOut||0)+"/"+(c.msgsIn||0)+"  bytes out/in "+(c.bytesOut||0)+"/"+(c.bytesIn||0)+"\n"+
				(x.proto==="UDP"?"retransmits "+(c.retransmissions||0)+"  dup "+(c.duplicates||0)+"  out-of-order "+(c.outOfOrder||0)+"  lost(state) "+(c.unreliableLost||0)+"  stale "+(c.staleDiscarded||0)+"\n"+
				"srtt "+(x.transport.srtt)+"  rto "+(x.transport.rto)+"  unacked "+(x.transport.unacked)+"\n":"backpressure drops "+(c.stateDroppedBackpressure||0)+"\n")+
				"desync corrections "+(c.ui_desync||0)+"  link drops "+(c.linkDown||0)+
				(c.simDropped||c.simTcpRetransmitDelays?"\nSIM dropped "+(c.simDropped||0)+" tcpRetxDelays "+(c.simTcpRetransmitDelays||0):"")
			)+'</div>';
		}
		ov.innerHTML=h;
		// wire events
		var $=id=>document.getElementById(id);
		ov.querySelectorAll("input").forEach(i=>{
			["keydown","keyup","keypress"].forEach(ev=>i.addEventListener(ev,e=>{ e.stopPropagation(); if (ev==="keydown"&&e.key==="Enter") { if (i.id==="rawRoom") createRoom(); else doAuth(false); } }));
		});
		if ($("rawLogin")) $("rawLogin").onclick=()=>doAuth(false);
		if ($("rawRegister")) $("rawRegister").onclick=()=>doAuth(true);
		if ($("rawCreate")) $("rawCreate").onclick=createRoom;
		if ($("rawLogout")) $("rawLogout").onclick=()=>{ RAWLINK.send(RAWCODE.LOGOUT,{}); RAWLINK.loggedIn=false; S.user=null; render(); };
		if ($("rawLeave")) $("rawLeave").onclick=leaveRoom;
		if ($("rawResOk")) $("rawResOk").onclick=()=>{ S.result=null; render(); };
		if ($("rawResLobby")) $("rawResLobby").onclick=()=>{ S.result=null; leaveRoom(); };
		ov.querySelectorAll("[data-join]").forEach(b=>b.onclick=()=>joinRoom(b.getAttribute("data-join")));
	}

	// keep typed values across re-renders
	var origRender=render;
	render=function(){
		var keep={}; ["rawUser","rawPass","rawRoom"].forEach(id=>{ var e=document.getElementById(id); if (e) keep[id]=[e.value,document.activeElement===e]; });
		origRender();
		for (var id in keep) { var e=document.getElementById(id); if (e) { e.value=keep[id][0]; if (keep[id][1]) e.focus(); } }
	};

	window.addEventListener("keydown",function(e){ if (e.keyCode==114) { S.hud=!S.hud; render(); e.preventDefault(); } },true);
	window.addEventListener("DOMContentLoaded",function(){
		ov=document.createElement("div"); ov.id="rawov"; document.body.appendChild(ov);
		render(); connect();
	});
	if (document.readyState!=="loading") { ov=document.createElement("div"); ov.id="rawov"; document.body.appendChild(ov); render(); connect(); }
})();

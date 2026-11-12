// [raw-sockets project] Third PvP netplay protocol: talks to the local bridge (bridge/bridge.js)
// over a localhost WebSocket. The bridge talks to the game server with a RAW TCP or RAW UDP
// socket. This class does not know (or choose) which one: the same game code runs on both.
// Same interface as NetplaySocketIo (client/js/netplay-socketio.js).
function NetplayRaw(master) {
	const RAW_NETEVENT_ENDGAME=13, RAW_NETEVENT_KICKPLAYER=17; // from game.js

	var listener, outPacket, inPlayersData, inPlayersEvents, roomPlayers=[], roster=[];

	this.state=NETPLAYSTATE_OFF;
	this.isAvailable=false;
	this.updateTime=0;            // send full player state every frame (30 Hz)
	this.predictorStrength=0.5;

	this.initialize=function(){
		if (window.RAW_BRIDGE && window.RAWLINK) {
			this.isAvailable=true;
			var self=this;
			RAWLINK.netplay=this;
			RAWLINK.on(NETCODE_ROOMCONFIG,function(data){
				roomPlayers=data.players||[];
				if (self.state==NETPLAYSTATE_PLAYING) {
					// mid-game room change (someone dropped): only the host role can change
					if (listener) listener.isMaster=!!(roomPlayers[0]&&roomPlayers[0].isYou);
				} else if (self.state>=NETPLAYSTATE_JOIN && listener) {
					self.setState(NETPLAYSTATE_JOINED);
					listener.onRoomPlayersUpdated(roomPlayers);
					if (data.setup) listener.onSetupUpdated(data.setup);
				}
			});
			RAWLINK.on(NETCODE_CONFIRM,function(data){ if (listener) listener.onPlayerConfirm(data); });
			RAWLINK.on(NETCODE_ROOMFROZEN,function(data){ if (self.state>=NETPLAYSTATE_JOIN && listener) listener.onStartGame(data); });
			RAWLINK.on(NETCODE_SETUP,function(data){ if (self.state>=NETPLAYSTATE_JOIN && listener) listener.onSetupUpdated(data); });
			RAWLINK.on(NETCODE_DATA,function(data){
				if (self.state==NETPLAYSTATE_PLAYING) {
					data[0].forEach(packet=>{ inPlayersData[packet.id]=packet.data; });
					data[1].forEach(event=>{ inPlayersEvents.push(event); });
				}
			});
			RAWLINK.on(NETCODE_EVENT,function(data){ if (self.state==NETPLAYSTATE_PLAYING) inPlayersEvents.push(data); });
			var onGone=function(data){
				if (self.state==NETPLAYSTATE_PLAYING) {
					var slot=roster.indexOf(data.id);
					if (slot!=-1) inPlayersEvents.push([RAW_NETEVENT_KICKPLAYER,slot]); // dropped player leaves the arena
				}
			};
			RAWLINK.on(RAWCODE.PLAYER_DROPPED,onGone);
			RAWLINK.on(RAWCODE.PLAYER_LEFT,onGone);
			RAWLINK.on(RAWCODE.GAME_RESULT,function(){
				if (self.state==NETPLAYSTATE_PLAYING) inPlayersEvents.push([RAW_NETEVENT_ENDGAME]);
			});
			return true;
		} else return false;
	}

	this.addOptions=function(netModes,options) {
		netModes.push({id:"netModeRaw",label:"Raw "+RAW_BRIDGE.proto+" sockets",netplay:this,enable:[]});
	}

	this.initializeConfig=function() {
		var id=SETTINGS.getOptionValueById("netMode","netModeRaw");
		if (id!==undefined) CONFIG.netMode=id;
	}

	this.getHeader=function() { return CONFIG.netNickname+" "+DOT_SYMBOL+" "+RAW_BRIDGE.proto+" room: "+CONFIG.netRoom; }
	this.getSettingsNotes=function() { return ["Raw "+RAW_BRIDGE.proto+" via local bridge","Server "+RAW_BRIDGE.server]; }

	this.show=function(first,listen) {
		listener=listen;
		if (RAWLINK.room) CONFIG.netRoom=RAWLINK.room;
		if (RAWLINK.user) CONFIG.netNickname=RAWLINK.user.toUpperCase().substr(0,10);
		if (!first) {
			RAWLINK.send(NETCODE_LEAVEROOM);
			this.setState(NETPLAYSTATE_ON);
		}
		RAWLINK.onNetplayScreen(true);
	}

	this.quit=function() {
		RAWLINK.send(NETCODE_LEAVEROOM);
		this.setState(NETPLAYSTATE_ON,true);
		RAWLINK.onNetplayScreen(false);
	}

	this.setState=function(state,wait,setup) {
		this.state=state;
		if (!wait) this.manageConnection(setup);
	}

	this.manageConnection=function(setup) {
		switch (this.state) {
			case NETPLAYSTATE_OFF: { this.setState(NETPLAYSTATE_PREPARING); break; }
			case NETPLAYSTATE_PREPARING: { this.setState(NETPLAYSTATE_ON); break; }
			case NETPLAYSTATE_ON: { this.setState(NETPLAYSTATE_CONNECT); break; }
			case NETPLAYSTATE_CONNECT: { if (RAWLINK.loggedIn) this.setState(NETPLAYSTATE_CONNECTING); break; }
			case NETPLAYSTATE_CONNECTING: { this.setState(NETPLAYSTATE_JOIN); break; }
			case NETPLAYSTATE_JOIN: {
				RAWLINK.send(NETCODE_JOINROOM,[CONFIG.netRoom,CONFIG.netNickname,setup]);
				this.setState(NETPLAYSTATE_JOINING,true);
				break;
			}
			case NETPLAYSTATE_JOINING: { this.setState(NETPLAYSTATE_JOIN,true); break; }
		}
	}

	this.updateSetup=function(setup) { RAWLINK.send(NETCODE_UPDATESETUP,setup); }
	this.setConfirm=function(confirm) { RAWLINK.send(NETCODE_SETCONFIRM,confirm); }

	this.sendStartGame=function(gamesettings) {
		this.setState(NETPLAYSTATE_PLAYING);
		RAWLINK.send(NETCODE_FREEZEROOM,gamesettings);
	}

	this.startGame=function() {
		this.setState(NETPLAYSTATE_PLAYING);
		outPacket=[0,[]];
		inPlayersData=[];
		inPlayersEvents=[];
		roster=roomPlayers.map(p=>p.id);   // game slot i == i-th player of the room
		RAWLINK.onGameStart();
	}

	this.sendEventTo=function (player,data) {
		if (this.state==NETPLAYSTATE_PLAYING) RAWLINK.send(NETCODE_SENDEVENT,[player.netId,data]);
	}

	this.broadcastEvent=function (data) {
		if (this.state==NETPLAYSTATE_PLAYING) outPacket[1].push(data);
	}

	this.openStartFrame=function(players) { return inPlayersData; }
	this.closeStartFrame=function() { inPlayersData.length=0; }

	this.broadcastPlayersData=function(data) {
		// quantize positions/angles to keep datagrams small (2 decimals for x/y, 3 for angle)
		for (var i=0;i<data.length;i++) {
			var d=data[i].data;
			if (d) for (var j=3;j<6;j++) if (typeof d[j]=="number") d[j]=Math.round(d[j]*(j==5?1000:100))/(j==5?1000:100);
		}
		outPacket[0]=data;
		if (outPacket[0].length||outPacket[1].length) RAWLINK.send(NETCODE_BROADCAST,outPacket);
		outPacket[1].length=0;
	}

	this.endFrame=function(players) { return inPlayersEvents; }
	this.flushFrame=function() { inPlayersEvents.length=0; }
}

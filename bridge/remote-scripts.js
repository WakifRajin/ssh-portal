// POSIX shell scripts that run on the remote host via `sh -s -- args...`.

// Usage: sh -s -- <share|virtual> <display-number> <WxH>
// Starts (or reuses) a VNC server bound to the remote's localhost only; the
// bridge reaches it through an SSH port-forward. Prints PORT=, PASS=, DISPLAY=.
export const DESKTOP_START = String.raw`

MODE="$1"; D="$2"; GEO="$3"; [ -n "$GEO" ] || GEO=1600x900
DIR="$HOME/.ssh-portal"; mkdir -p "$DIR"; chmod 700 "$DIR"
have() { command -v "$1" >/dev/null 2>&1; }
listening() {
  if have ss; then ss -ltn 2>/dev/null | grep -Eq "[:.]$1[[:space:]]"; return; fi
  if have netstat; then netstat -ltn 2>/dev/null | grep -Eq "[:.]$1[[:space:]]"; return; fi
  if have nc; then nc -z 127.0.0.1 "$1" >/dev/null 2>&1; return; fi
  return 1
}
detach() { if have setsid; then setsid "$@"; else nohup "$@"; fi; }
PWF="$DIR/pass-$D"
if [ ! -s "$PWF.txt" ]; then
  (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8 > "$PWF.txt")
fi
PW=$(cat "$PWF.txt")

start_x11vnc() { # $1 display, $2 port, $3 extra
  have x11vnc || { echo "ERROR: x11vnc is not installed on the remote (e.g. sudo apt install x11vnc)"; exit 2; }
  x11vnc -storepasswd "$PW" "$PWF.x11" >/dev/null 2>&1
  x11vnc -display "$1" $3 -localhost -rfbport "$2" -rfbauth "$PWF.x11" -forever -shared -noxdamage -bg -o "$DIR/x11vnc-$D.log" >/dev/null 2>&1
}

if [ "$MODE" = share ]; then
  PORT=$((5950 + D))
  if ! listening $PORT; then start_x11vnc ":$D" $PORT "-auth guess"; fi
else
  PORT=$((5900 + D))
  if ! listening $PORT; then
    if have Xvnc && have vncpasswd; then
      echo "$PW" | vncpasswd -f > "$PWF.vnc" 2>/dev/null; chmod 600 "$PWF.vnc"
      detach Xvnc ":$D" -geometry "$GEO" -depth 24 -localhost -rfbport $PORT -SecurityTypes VncAuth -PasswordFile "$PWF.vnc" -AlwaysShared > "$DIR/xvnc-$D.log" 2>&1 < /dev/null &
    elif have Xvfb; then
      detach Xvfb ":$D" -screen 0 "$GEO"x24 -nolisten tcp > "$DIR/xvfb-$D.log" 2>&1 < /dev/null &
      sleep 1
      start_x11vnc ":$D" $PORT ""
    else
      echo "ERROR: no virtual X server found. Install TigerVNC (Xvnc) or Xvfb + x11vnc on the remote,"
      echo "e.g. sudo apt install tigervnc-standalone-server   or   sudo apt install xvfb x11vnc"
      exit 2
    fi
    sleep 1
    export DISPLAY=":$D"
    unset SESSION_MANAGER DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY XDG_SESSION_TYPE
    if have dbus-launch; then L="dbus-launch --exit-with-session"; else L=""; fi
    for s in startxfce4 startlxqt startlxde mate-session startplasma-x11 cinnamon-session gnome-session openbox-session fluxbox icewm-session twm xterm; do
      if have "$s"; then
        detach $L "$s" > "$DIR/session-$D.log" 2>&1 < /dev/null &
        echo "SESSION=$s"
        break
      fi
    done
  fi
fi

i=0
while [ $i -lt 20 ]; do
  listening $PORT && break
  sleep 1; i=$((i + 1))
done
listening $PORT || { echo "ERROR: VNC server did not start. Logs are in $DIR on the remote."; exit 3; }
echo "PORT=$PORT"
echo "PASS=$PW"
echo "DISPLAY=:$D"
`;

// Usage: sh -s -- <share|virtual> <display-number>
export const DESKTOP_STOP = String.raw`
MODE="$1"; D="$2"
if [ "$MODE" = share ]; then PORT=$((5950 + D)); else PORT=$((5900 + D)); fi
pkill -f "x11vnc .*-rfbport $PORT" 2>/dev/null
if [ "$MODE" != share ]; then
  pkill -f "Xvnc :$D( |$)" 2>/dev/null
  pkill -f "Xvfb :$D( |$)" 2>/dev/null
fi
echo stopped
`;

export const SYSINFO = String.raw`
echo "HOST=$(hostname 2>/dev/null)"
echo "OS=$( ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s)"
echo "KERNEL=$(uname -srm)"
echo "UPTIME=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
echo "LOAD=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
echo "CPUS=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
echo "CPU=$(head -1 /proc/stat 2>/dev/null)"
echo "MEM=$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}/^SwapTotal/{st=$2}/^SwapFree/{sf=$2}END{print t" "a" "st" "sf}' /proc/meminfo 2>/dev/null)"
echo "USERS=$(who 2>/dev/null | wc -l)"
echo "--DF--"
df -kP -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | tail -n +2
echo "--PS--"
ps -eo pid=,user=,pcpu=,pmem=,etime=,comm= --sort=-pcpu 2>/dev/null | head -n 60
`;

// LAN discovery from the remote host: ping-sweep its /24, then read the
// neighbour table. Prints "IFACE name addr/prefix" and "HOST ip mac name".
export const NET_SCAN = String.raw`
command -v ip >/dev/null 2>&1 || { echo "ERROR: the 'ip' command is not available on the remote"; exit 2; }
ip -4 -o addr show scope global | awk '{print "IFACE " $2 " " $4}'
SELF=$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]; exit}')
[ -n "$SELF" ] || { echo "ERROR: the remote has no IPv4 address"; exit 2; }
echo "SELF $SELF"
BASE=$(echo "$SELF" | cut -d. -f1-3)
i=1
while [ $i -le 254 ]; do
  ( ping -c 1 -W 1 "$BASE.$i" >/dev/null 2>&1 ) &
  i=$((i + 1))
done
wait
ip -4 neigh show | awk '$0 !~ /FAILED|INCOMPLETE/ {mac=""; for (i = 1; i <= NF; i++) if ($i == "lladdr") mac = $(i + 1); print $1 " " mac}' | sort -u -t. -k4,4n | while read -r IP MAC; do
  case "$IP" in "$BASE".*) ;; *) continue ;; esac
  NAME=$(getent hosts "$IP" 2>/dev/null | awk '{print $2; exit}')
  [ -n "$MAC" ] || MAC=-
  [ -n "$NAME" ] || NAME=-
  echo "HOST $IP $MAC $NAME"
done
NAME=$(hostname 2>/dev/null)
[ -n "$NAME" ] || NAME=-
echo "HOST $SELF self $NAME"
`;

export const NET_INFO = String.raw`
echo "--ADDR--"; (ip -br addr 2>/dev/null || ifconfig 2>/dev/null)
echo "--ROUTE--"; (ip route 2>/dev/null || netstat -rn 2>/dev/null)
echo "--DNS--"; grep -E '^(nameserver|search)' /etc/resolv.conf 2>/dev/null
echo "--LISTEN--"; (ss -tulpnH 2>/dev/null || ss -tulnH 2>/dev/null || netstat -tuln 2>/dev/null | tail -n +3)
echo "--CONN--"; (ss -tnpH state established 2>/dev/null || ss -tnH state established 2>/dev/null) | head -n 200
`;

// Usage: sh -s -- <docker|podman>
// One exec for the whole Docker panel. Sections are marker lines; parsed by
// parseDockerList() in admin.js. A failing `ps` becomes --ERROR-- plus its text.
export const DOCKER_LIST = String.raw`
R="$1"
command -v "$R" >/dev/null 2>&1 || { echo '--NOTINSTALLED--'; exit 0; }
OUT=$("$R" ps -a --format '{{json .}}' </dev/null 2>&1); RC=$?
if [ "$RC" -ne 0 ]; then echo '--ERROR--'; echo "$OUT"; exit 0; fi
echo '--PS--'; echo "$OUT"
echo '--IMAGES--'; "$R" images --format '{{json .}}' </dev/null 2>/dev/null
echo '--VOLUMES--'; "$R" volume ls --format '{{json .}}' </dev/null 2>/dev/null
echo '--NETWORKS--'; "$R" network ls --format '{{json .}}' </dev/null 2>/dev/null
echo '--STATS--'
if [ -n "$("$R" ps -q </dev/null 2>/dev/null)" ]; then "$R" stats --no-stream --format '{{json .}}' </dev/null 2>/dev/null; fi
`;

// Usage: sh -s -- [usb]
// Hardware inventory. Every command reads </dev/null because this script
// itself arrives on stdin and a greedy tool would swallow the rest of it.
// With "usb" only the (cheap) USB section is printed, for hot-plug polling.
// Lines are tab separated: U (usb), I (iface), WIFI, N (neighbour name).
export const DEVICES = String.raw`
have() { command -v "$1" >/dev/null 2>&1; }
rd() { R=""; [ -r "$1" ] && read -r R < "$1" 2>/dev/null; return 0; }

echo '--TOOLS--'
for t in lsusb lsblk lspci bluetoothctl lldpctl networkctl bridge iw nmcli; do
  if have "$t"; then echo "$t=1"; else echo "$t=0"; fi
done

echo '--USB--'
for d in /sys/bus/usb/devices/*; do
  [ -f "$d/idVendor" ] || continue
  rd "$d/busnum"; BUS=$R
  rd "$d/devnum"; DEV=$R
  rd "$d/idVendor"; VID=$R
  rd "$d/idProduct"; PID=$R
  rd "$d/manufacturer"; MAN=$R
  rd "$d/product"; PRD=$R
  rd "$d/speed"; SPD=$R
  rd "$d/bDeviceClass"; DCL=$R
  rd "$d/serial"; SER=$R
  ICL=""
  if [ "$DCL" = 00 ] || [ "$DCL" = ef ]; then
    for f in "$d":*/bInterfaceClass; do
      if [ -f "$f" ]; then rd "$f"; ICL=$R; break; fi
    done
  fi
  printf 'U\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$BUS" "$DEV" "$VID" "$PID" "$MAN" "$PRD" "$SPD" "$DCL" "$ICL" "$SER"
done
echo '--LSUSB--'
have lsusb && lsusb </dev/null 2>/dev/null
[ "$1" = usb ] && exit 0

echo '--LSBLK--'
if have lsblk; then
  lsblk -J -b -o NAME,PATH,SIZE,TYPE,MODEL,VENDOR,TRAN,MOUNTPOINTS,FSTYPE,LABEL,RM,FSUSED,FSAVAIL </dev/null 2>/dev/null ||
  lsblk -J -b -o NAME,PATH,SIZE,TYPE,MODEL,VENDOR,TRAN,MOUNTPOINT,FSTYPE,LABEL,RM,FSUSED,FSAVAIL </dev/null 2>/dev/null ||
  lsblk -J -b -o NAME,PATH,SIZE,TYPE,MODEL,VENDOR,TRAN,MOUNTPOINT,FSTYPE,LABEL,RM </dev/null 2>/dev/null
fi

echo '--PCI--'
have lspci && lspci -mm </dev/null 2>/dev/null

TO=""; have timeout && TO="timeout 4"
echo '--BTSHOW--'
have bluetoothctl && $TO bluetoothctl show </dev/null 2>/dev/null
echo '--BTPAIRED--'
have bluetoothctl && $TO bluetoothctl devices Paired </dev/null 2>/dev/null
echo '--BTCONN--'
have bluetoothctl && { $TO bluetoothctl devices Connected </dev/null 2>/dev/null || echo '!unsupported'; }

echo '--IFACES--'
ANYW=0
for p in /sys/class/net/*; do
  [ -e "$p" ] || continue
  n=$(basename "$p")
  rd "$p/address"; MAC=$R
  rd "$p/operstate"; ST=$R
  rd "$p/speed"; SP=$R
  rd "$p/duplex"; DX=$R
  rd "$p/type"; TY=$R
  DR=$(readlink "$p/device/driver" 2>/dev/null)
  MS=$(readlink "$p/master" 2>/dev/null)
  W=0; B=0; PH=0
  if [ -d "$p/wireless" ] || [ -d "$p/phy80211" ]; then W=1; ANYW=1; fi
  [ -d "$p/bridge" ] && B=1
  [ -e "$p/device" ] && PH=1
  printf 'I\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$MAC" "$ST" "$SP" "$DX" "$TY" "$DR" "$MS" "$W" "$B" "$PH"
  if [ "$W" = 1 ] && have iw; then
    iw dev "$n" link </dev/null 2>/dev/null | awk -v n="$n" '/SSID:/ {sub(/^[ \t]*SSID: /, ""); s = $0} /signal:/ {sig = $2} END {if (s != "") printf "WIFI\t%s\t%s\t%s\n", n, s, sig}'
  fi
done
echo '--NMWIFI--'
if [ "$ANYW" = 1 ] && have nmcli; then
  nmcli -t -f ACTIVE,DEVICE,SIGNAL,SSID dev wifi list --rescan no </dev/null 2>/dev/null | grep '^yes'
fi

echo '--ADDR--'
have ip && ip -o addr show </dev/null 2>/dev/null

echo '--NEIGH--'
have ip && ip neigh show </dev/null 2>/dev/null
echo '--NAMES--'
if have ip && have getent; then
  TO1=""; have timeout && TO1="timeout 1"
  ip neigh show </dev/null 2>/dev/null | awk '/lladdr/ && !/FAILED|INCOMPLETE/ {print $1}' | head -n 64 | while read -r IP; do
    NM=$($TO1 getent hosts "$IP" </dev/null 2>/dev/null | awk '{print $2; exit}')
    [ -n "$NM" ] && printf 'N\t%s\t%s\n' "$IP" "$NM"
  done
fi

echo '--LLDPJSON--'
have lldpctl && lldpctl -f json </dev/null 2>/dev/null
echo '--NETWORKCTL--'
have networkctl && networkctl lldp --no-pager </dev/null 2>/dev/null

echo '--FDB--'
have bridge && bridge fdb show </dev/null 2>/dev/null
exit 0
`;

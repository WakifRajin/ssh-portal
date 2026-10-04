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

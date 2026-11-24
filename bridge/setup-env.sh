#!/bin/sh
# bridge/setup-env.sh - Tao bridge/.env mot lan duy nhat (Mac/Linux).
# Hoi GitHub/OAuth, repo path va auto-update options; ghi vao .env (chmod 600).
# Chay:  sh bridge/setup-env.sh
# Sau do chay bridge nhu binh thuong - no tu doc .env, khong can dan
# lai gi trong dashboard nua.
set -eu
cd "$(dirname "$0")"
ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  printf 'bridge/.env da co. Ghi de se XOA cau hinh cu.\n'
  printf 'Ghi de? (y/N): '
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo 'Huy - giu nguyen bridge/.env cu.'; exit 0 ;;
  esac
fi
echo '=== Tao bridge/.env (chi chay 1 lan) ==='
echo 'De trong neu khong co gia tri do (co the dien sau).'
echo 'Chu y: khong bao gio gui file .env cho ai, khong day len GitHub.'
printf 'GitHub PAT (ghp_... hoac github_pat_...): '
read -r pat
printf 'OAuth Client ID (vd Ov23...): '
read -r cid
printf 'OAuth Client Secret: '
read -r csec
printf 'Duong dan repo mac dinh (vd /home/ban/MyRepo, de trong neu chua co): '
read -r repo
printf 'Bat GitHub auto-update? (y/N): '
read -r au
printf 'Chu ky auto-update bang giay (15-3600, mac dinh 60): '
read -r interval
[ -n "$interval" ] || interval=60
printf 'Tu dong pull repo local khi working tree sach? (y/N): '
read -r autosync
case "$au" in y|Y|yes|YES) auto_update=true ;; *) auto_update=false ;; esac
case "$autosync" in y|Y|yes|YES) auto_sync=true ;; *) auto_sync=false ;; esac
case "$interval" in *[!0-9]*|'') interval=60 ;; esac
[ "$interval" -ge 15 ] 2>/dev/null || interval=15
[ "$interval" -le 3600 ] 2>/dev/null || interval=3600
TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
{
  echo '# bridge/.env - TU DONG TAO BOI setup-env.sh. KHONG DAY LEN GITHUB.'
  echo '# Chi may nay duoc doc file nay. Ai co file nay se dang nhap GitHub duoc nhu ban.'
  echo "BRIDGE_TOKEN=$TOKEN"
  echo 'BRIDGE_PORT=17321'
  echo "GITHUB_PAT=$pat"
  echo "GITHUB_OAUTH_CLIENT_ID=$cid"
  echo "GITHUB_OAUTH_CLIENT_SECRET=$csec"
  echo "DEFAULT_REPO_PATH=$repo"
  echo "GITHUB_AUTO_UPDATE_ENABLED=$auto_update"
  echo "GITHUB_AUTO_UPDATE_INTERVAL_SECONDS=$interval"
  echo "GITHUB_AUTO_SYNC=$auto_sync"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo ''
echo 'Xong: bridge/.env da duoc tao (chi may nay doc duoc).'
echo 'Bridge token cua ban (dan 1 lan vao extension, muc LOCAL BRIDGE):'
echo "$TOKEN"
echo 'Bay gio chay bridge nhu binh thuong - no tu dang nhap GitHub tu .env.'

#!/usr/bin/env bash
# 预取 .deb（尽力而为，只是提速）：读 apt 的 --print-uris 输出（每行 'URL' 文件名 大小 哈希类型:哈希），
# 把还没有的包并行下载到目标目录。镜像慢就快速放弃（低于 200 kB/s 持续 15 秒即中止），换下一个镜像。
# 2026-11-06 PR #279：azure.archive.ubuntu.com 偶发只有 15-47 kB/s，一个 61 MB 的包能拖 26 分钟。
#
# 安全性不靠这个脚本：
# - Playwright 系统库：之后照常运行的 apt 会按签名索引的 SHA256 重新核对目录里的每个 .deb，对不上就不用、自己重新下载；
# - fonts-noto-cjk：安装步骤用 dpkg -i 之前自己核对 SHA256。
# 这里核对大小和哈希只是为了不留下半截文件。任何失败都只打警告、退出 0，后面的 apt 照常下载，装的东西不变。
#
# 用法：prefetch-debs.sh <目标目录> < uris.txt
set -uo pipefail

dest="${1:?usage: prefetch-debs.sh <dest-dir> < uris}"
mkdir -p "$dest"

# 同一路径的备用镜像（Ubuntu 主仓库）。只换主机，路径不变
MIRRORS=(http://archive.ubuntu.com/ubuntu http://us.archive.ubuntu.com/ubuntu)

hash_ok() { # 文件 大小 哈希类型:哈希
  local f="$1" size="$2" h="$3" algo sum got
  [ -f "$f" ] || return 1
  [ "$(stat -c %s "$f")" = "$size" ] || return 1
  algo="${h%%:*}"; sum="${h#*:}"
  case "$algo" in
    SHA256) got="$(sha256sum "$f" | cut -d' ' -f1)" ;;
    SHA512) got="$(sha512sum "$f" | cut -d' ' -f1)" ;;
    SHA1) got="$(sha1sum "$f" | cut -d' ' -f1)" ;;
    MD5Sum) got="$(md5sum "$f" | cut -d' ' -f1)" ;;
    *) return 1 ;;
  esac
  [ "$got" = "$sum" ]
}

fetch_one() { # 'URL' 文件名 大小 哈希
  local url="${1//\'/}" name="$2" size="$3" h="$4" tmp start alt
  local out="$dest/$name"
  if hash_ok "$out" "$size" "$h"; then echo "have  $name"; return 0; fi
  local urls=() rel="" list base
  case "$url" in
    mirror+file:*)
      # GitHub runner 的 apt 源是 mirror+file:/etc/apt/apt-mirrors.txt（2026-11-06 PR #279 实测）：--print-uris 给的是
      # mirror+file:<镜像清单>/pool/...，curl 不认。按 apt 的 mirror 方法展开：清单每行第一列是一个镜像根，依次拼上 pool/ 之后的路径
      list="${url#mirror+file:}"; list="${list%%/pool/*}"; rel="pool/${url#*/pool/}"
      if [ -r "$list" ]; then
        while read -r base _; do
          case "$base" in ''|'#'*) continue ;; esac
          urls+=("${base%/}/$rel")
        done < "$list"
      fi ;;
    *)
      urls=("$url")
      case "$url" in */ubuntu/pool/*) rel="pool/${url#*/ubuntu/pool/}" ;; esac ;;
  esac
  if [ -n "$rel" ]; then for alt in "${MIRRORS[@]}"; do urls+=("$alt/$rel"); done; fi
  if [ "${#urls[@]}" -eq 0 ]; then echo "::warning::prefetch $name: unsupported URI ${url%%/pool/*}, apt will download it itself"; return 0; fi
  tmp="$out.part.$$"
  for u in "${urls[@]}"; do
    start=$SECONDS
    if curl -fsSL --connect-timeout 10 --speed-limit 204800 --speed-time 15 --max-time 300 -o "$tmp" "$u" \
      && hash_ok "$tmp" "$size" "$h"; then
      mv -f "$tmp" "$out"
      echo "got   $name ($((size / 1024)) KB, $((SECONDS - start))s) from ${u%%/pool/*}"
      return 0
    fi
    echo "::warning::prefetch $name from ${u%%/pool/*} failed or too slow after $((SECONDS - start))s"
    rm -f "$tmp"
  done
  echo "::warning::prefetch $name: all mirrors failed, apt will download it itself"
  return 0
}
export -f fetch_one hash_ok
export dest MIRRORS_STR="${MIRRORS[*]}"

lines="$(grep "^'" || true)"
if [ -z "$lines" ]; then echo "prefetch: nothing to fetch"; exit 0; fi
echo "prefetch: $(wc -l <<< "$lines") file(s) → $dest"
# 4 路并行；每行 4 个字段原样传给 fetch_one
# shellcheck disable=SC2016
xargs -P 4 -L 1 bash -c 'MIRRORS=($MIRRORS_STR); fetch_one "$@"' _ <<< "$lines" || true
exit 0

#!/bin/sh
# pre-push 第一道检查：推到公开仓库（URL 以 /codex-echoink.git 结尾）时，只放行 main 和 Tag。
# 参数：$1 远端名，$2 远端 URL；标准输入：git 传来的 "<本地ref> <本地sha> <远端ref> <远端sha>" 行。
case "$2" in
  */codex-echoink.git|*/codex-echoink|*/codex-echoink/) ;;
  *) cat >/dev/null; exit 0 ;;
esac
status=0
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  [ -z "$remote_ref" ] && continue
  case "$remote_ref" in
    refs/heads/main|refs/tags/*) ;;
    *) echo "已拦截：公开仓库 codex-echoink 只能推 main 和 Tag，不能推 $remote_ref。开发分支请推 origin（私有 codex-echoink-dev）。" >&2; status=1 ;;
  esac
done
exit $status

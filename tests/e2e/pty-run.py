#!/usr/bin/env python3
"""
在伪终端里运行一条命令，给端到端测试用（仓库里没有 node-pty）：
  python3 pty-run.py <列数> <行数> <命令> [参数…]
标准输入 → 伪终端；伪终端输出 → 标准输出。命令结束后以它的退出码退出。
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios

cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
stdin_open = True
code = 0
while True:
    rl = [fd] + ([0] if stdin_open else [])
    try:
        r, _, _ = select.select(rl, [], [], 0.2)
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            stdin_open = False
        else:
            os.write(fd, data)
try:
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
except ChildProcessError:
    pass
sys.exit(code if code >= 0 else 128 - code)

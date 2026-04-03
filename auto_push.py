import pexpect
import sys
import os

os.environ['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

child = pexpect.spawn('npx.cmd drizzle-kit push', encoding='utf-8')
child.logfile = sys.stdout

while True:
    try:
        index = child.expect(['\?', pexpect.EOF, pexpect.TIMEOUT], timeout=30)
        if index == 0:
            child.sendline()
        elif index == 1:
            print("EOF")
            break
        elif index == 2:
            print("TIMEOUT")
            child.sendline()
    except Exception as e:
        print("Done or Error:", e)
        break

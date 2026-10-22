//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow 非 Windows 平台无控制台窗口概念。
func hideWindow(cmd *exec.Cmd) {}

// prepTreeCmd 准备可整树终止的子进程（独立进程组，便于按组发送信号）。
func prepTreeCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killTree 结束进程组（负 pid 向整组发 SIGKILL）。
func killTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

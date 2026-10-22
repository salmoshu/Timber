//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

// hideWindow 隐藏子进程控制台窗口（wsl.exe 等控制台程序否则会弹 CMD 窗口）。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

// prepTreeCmd 准备可整树终止的子进程（Windows 仅隐藏控制台窗口）。
func prepTreeCmd(cmd *exec.Cmd) {
	hideWindow(cmd)
}

// killTree 结束整个进程树（cmd /c 垫片会再启动 node 等子进程，仅杀直接子进程会残留）。
func killTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	k := exec.Command("taskkill", "/pid", strconv.Itoa(cmd.Process.Pid), "/t", "/f")
	hideWindow(k)
	return k.Run()
}

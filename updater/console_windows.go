//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	setConsoleTitleW = kernel32.NewProc("SetConsoleTitleW")
	setConsoleCP     = kernel32.NewProc("SetConsoleOutputCP")
)

func setTitle(t string) {
	p, err := syscall.UTF16PtrFromString(t)
	if err == nil {
		setConsoleTitleW.Call(uintptr(unsafe.Pointer(p)))
	}
	setConsoleCP.Call(65001)
}

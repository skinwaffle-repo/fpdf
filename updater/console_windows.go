//go:build windows

package main

import (
	"errors"
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	shell32             = syscall.NewLazyDLL("shell32.dll")
	setConsoleTitleW    = kernel32.NewProc("SetConsoleTitleW")
	setConsoleCP        = kernel32.NewProc("SetConsoleOutputCP")
	waitForSingleObject = kernel32.NewProc("WaitForSingleObject")
	getExitCodeProcess  = kernel32.NewProc("GetExitCodeProcess")
	shellExecuteExW     = shell32.NewProc("ShellExecuteExW")
	isUserAnAdmin       = shell32.NewProc("IsUserAnAdmin")
	shChangeNotify      = shell32.NewProc("SHChangeNotify")
)

func setTitle(t string) {
	p, err := syscall.UTF16PtrFromString(t)
	if err == nil {
		setConsoleTitleW.Call(uintptr(unsafe.Pointer(p)))
	}
	setConsoleCP.Call(65001)
}

func isAdmin() bool {
	r, _, _ := isUserAnAdmin.Call()
	return r != 0
}

type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     syscall.Handle
}

// run a program elevated ("run as administrator" prompt) and wait for it
func runElevated(file string, args []string) (int, error) {
	verb, _ := syscall.UTF16PtrFromString("runas")
	f, _ := syscall.UTF16PtrFromString(file)
	p, _ := syscall.UTF16PtrFromString(strings.Join(args, " "))
	info := shellExecuteInfo{
		fMask:        0x00000040 | 0x00000100, // SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
		lpVerb:       verb,
		lpFile:       f,
		lpParameters: p,
		nShow:        1,
	}
	info.cbSize = uint32(unsafe.Sizeof(info))
	r, _, err := shellExecuteExW.Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		if errno, ok := err.(syscall.Errno); ok && errno == 1223 { // ERROR_CANCELLED
			return -1, errors.New("the admin prompt was cancelled")
		}
		return -1, fmt.Errorf("couldn't start the installer as admin: %v", err)
	}
	if info.hProcess == 0 {
		return 0, nil
	}
	defer syscall.CloseHandle(info.hProcess)
	waitForSingleObject.Call(uintptr(info.hProcess), 0xFFFFFFFF)
	var code uint32
	getExitCodeProcess.Call(uintptr(info.hProcess), uintptr(unsafe.Pointer(&code)))
	return int(code), nil
}

// tell Explorer icons changed (SHCNE_ASSOCCHANGED, SHCNF_FLUSH)
func refreshIcons() {
	shChangeNotify.Call(0x08000000, 0x1000, 0, 0)
}

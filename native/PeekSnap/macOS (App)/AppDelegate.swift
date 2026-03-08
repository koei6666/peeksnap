//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by 張浩楠 on 2026/03/08.
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Override point for customization after application launch.
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

}

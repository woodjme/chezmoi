-------------------------------------------------
-- ~/.hammerspoon/init.lua
-------------------------------------------------

hs.window.animationDuration = 0 -- all window movements are instant

-------------------------------------------------
-- Helpers
-------------------------------------------------

-- Bundle IDs are more reliable than app names for launching and matching.
-- Verified against the apps installed on this machine.
local bundleIDs = {
  ["Brave Browser"] = "com.brave.Browser",
  ["Ghostty"] = "com.mitchellh.ghostty",
  ["Todoist"] = "com.todoist.mac.Todoist",
  ["Slack"] = "com.tinyspeck.slackmacgap",
  ["Discord"] = "com.hnc.Discord",
  ["WhatsApp"] = "net.whatsapp.WhatsApp",
  ["Mail"] = "com.apple.mail",
}

local function appHint(appName)
  return bundleIDs[appName] or appName
end

local function launchApp(appName)
  local bundleID = bundleIDs[appName]
  if bundleID then
    hs.application.launchOrFocusByBundleID(bundleID)
  else
    hs.application.launchOrFocus(appName)
  end
end

-- Polls getterFn (every 50ms, up to timeoutSecs) and calls callback with its
-- first non-nil result. Alerts on timeout instead of failing silently.
local function waitFor(getterFn, callback, timeoutSecs, description)
  local first = getterFn()
  if first then
    callback(first)
    return
  end

  local deadline = hs.timer.secondsSinceEpoch() + (timeoutSecs or 5)
  hs.timer.waitUntil(
    function()
      return getterFn() ~= nil or hs.timer.secondsSinceEpoch() > deadline
    end,
    function()
      local result = getterFn()
      if result then
        callback(result)
      else
        hs.alert.show("Timed out waiting for " .. description)
      end
    end,
    0.05
  )
end

local function visibleWindow(appName)
  local app = hs.application.get(appHint(appName))
  if not app then return nil end

  local win = app:focusedWindow()
  if win and win:isVisible() then return win end

  return app:visibleWindows()[1]
end

-- Covers cold launches: waits for the app process and a visible window.
local function waitForVisibleWindow(appName, callback)
  waitFor(function() return visibleWindow(appName) end, callback, 5, appName .. " window")
end

local function launchAndMaximize(appName)
  launchApp(appName)
  waitForVisibleWindow(appName, function(win) win:maximize() end)
end

local function snap(win, frame)
  if win then win:setFrame(frame) end
end

-------------------------------------------------
-- ALT + ENTER / ALT + SHIFT + ENTER - App Maximize Bindings
-------------------------------------------------

local appBindings = {
  { mods = { "alt" }, key = "return", app = "Ghostty" },
  { mods = { "alt", "shift" }, key = "return", app = "Brave Browser" },
}

for _, binding in ipairs(appBindings) do
  hs.hotkey.bind(binding.mods, binding.key, function()
    launchAndMaximize(binding.app)
  end)
end

-------------------------------------------------
-- ALT + Q - Instant Todoist Side Panel Toggle
-------------------------------------------------

local todoistAppName = "Todoist"
local lastLeftWindow = nil

hs.hotkey.bind({ "alt" }, "q", function()
  local todoApp = hs.application.get(appHint(todoistAppName))
  local todoWin = todoApp and todoApp:mainWindow()
  local isVisible = todoWin and todoWin:isVisible()

  -- Toggle off: hide Todoist and restore the previously snapped window
  if isVisible then
    todoApp:hide()

    if lastLeftWindow and lastLeftWindow:isVisible() then
      lastLeftWindow:maximize()
    end

    lastLeftWindow = nil
    return
  end

  -- Toggle on: Todoist right third, previously focused window left two thirds
  local frontWin = hs.window.focusedWindow()
  lastLeftWindow = frontWin

  launchApp(todoistAppName)

  -- mainWindow instead of visibleWindow: a minimized Todoist window must
  -- still be found so it can be unminimized below
  waitFor(function()
    local app = hs.application.get(appHint(todoistAppName))
    return app and app:mainWindow() or nil
  end, function(win)
    win:unminimize()

    local f = win:screen():frame()
    local rightWidth = f.w / 3

    snap(win, {
      x = f.x + (f.w - rightWidth),
      y = f.y,
      w = rightWidth,
      h = f.h,
    })

    if frontWin and frontWin ~= win then
      snap(frontWin, {
        x = f.x,
        y = f.y,
        w = f.w * 2 / 3,
        h = f.h,
      })
    end
  end, 5, "Todoist window")
end)

-------------------------------------------------
-- ALT + 3 - Cycle through communication apps
-------------------------------------------------

local function findIndexForFrontApp(appList, front)
  if not front then return nil end

  local frontBundle = front:bundleID()
  local frontName = front:name()

  for i, appName in ipairs(appList) do
    if bundleIDs[appName] == frontBundle or appName == frontName then
      return i
    end
  end

  return nil
end

-- Cycles through appNames; from outside the group it returns to the last used one.
local function bindToggle(mods, key, appNames)
  local lastIndex = 1

  local function switchTo(i)
    if i > #appNames then i = 1 end
    lastIndex = i
    launchAndMaximize(appNames[i])
  end

  hs.hotkey.bind(mods, key, function()
    local idx = findIndexForFrontApp(appNames, hs.application.frontmostApplication())

    if idx then
      switchTo(idx + 1)
    else
      switchTo(lastIndex)
    end
  end)
end

bindToggle({ "alt" }, "3", {
  "Slack",
  "Discord",
  "WhatsApp",
  "Mail",
})

-------------------------------------------------
-- Auto-reload config
-------------------------------------------------

-- Global so the watcher is not garbage collected.
ConfigWatcher = hs.pathwatcher.new(hs.configdir, function(files)
  for _, file in ipairs(files) do
    if file:sub(-4) == ".lua" then
      hs.reload()
      return
    end
  end
end):start()

hs.alert.show("Hammerspoon config loaded")

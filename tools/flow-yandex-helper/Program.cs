using System.Collections;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

var options = HelperOptions.Parse(args);
if (options.ShowHelp || string.IsNullOrWhiteSpace(options.PlaylistUrl))
{
    WriteJson(new HelperResult(false, "Usage: FlowYandexMusicHelper --playlist-url <url>. Pass token via FLOW_YANDEX_TOKEN.", null, null));
    return options.ShowHelp ? 0 : 2;
}

var token = Environment.GetEnvironmentVariable("FLOW_YANDEX_TOKEN")?.Trim();
if (string.IsNullOrWhiteSpace(token))
{
    WriteJson(new HelperResult(false, "FLOW_YANDEX_TOKEN is required", null, null));
    return 2;
}

if (!TryParseYandexPlaylistRef(options.PlaylistUrl, out var user, out var kind))
{
    WriteJson(new HelperResult(false, "Unsupported Yandex Music playlist URL", null, null));
    return 2;
}

try
{
    var fromApi = await TryFetchWithKmApiAsync(token, user, kind);
    if (fromApi?.Tracks.Count > 0)
    {
        WriteJson(fromApi);
        return 0;
    }
}
catch
{
    // The NuGet package is unofficial and may change shape; direct API keeps the helper useful.
}

try
{
    var direct = await FetchWithDirectApiAsync(token, user, kind);
    WriteJson(direct);
    return direct.Ok ? 0 : 1;
}
catch (Exception ex)
{
    WriteJson(new HelperResult(false, "Yandex helper: " + ex.Message, "yandex", null));
    return 1;
}

static async Task<HelperResult?> TryFetchWithKmApiAsync(string token, string user, string kind)
{
    LoadYandexMusicAssemblies();
    var authType = AppDomain.CurrentDomain.GetAssemblies()
        .SelectMany(SafeGetTypes)
        .FirstOrDefault(t => t.Name == "AuthStorage");
    var rootType = AppDomain.CurrentDomain.GetAssemblies()
        .SelectMany(SafeGetTypes)
        .FirstOrDefault(t => t.Name is "YandexMusicApi" or "YandexMusicAPI");
    if (authType is null || rootType is null) return null;

    var storage = Activator.CreateInstance(authType);
    if (storage is null) return null;

    var usersBranch = GetBranch(rootType, "Users");
    if (usersBranch is not null)
    {
        await InvokeMaybeAsync(usersBranch, ["AuthorizeAsync", "Authorize"], storage, token);
    }

    var playlistBranch = GetBranch(rootType, "Playlist");
    if (playlistBranch is null) return null;

    var playlist = await InvokeMaybeAsync(playlistBranch, ["GetAsync", "Get"], storage, user, kind);
    return PlaylistToResult(playlist, "Yandex Playlist");
}

static void LoadYandexMusicAssemblies()
{
    foreach (var name in new[] { "KM.Yandex.Music.Api", "Yandex.Music.Api" })
    {
        try { Assembly.Load(name); } catch { }
    }

    foreach (var file in Directory.GetFiles(AppContext.BaseDirectory, "*Yandex*Music*.dll"))
    {
        try { Assembly.LoadFrom(file); } catch { }
    }
}

static async Task<HelperResult> FetchWithDirectApiAsync(string token, string user, string kind)
{
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("OAuth", token);
    http.DefaultRequestHeaders.TryAddWithoutValidation("X-Yandex-Music-Client", "WindowsPhone/3.20");
    http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "Windows 10");

    var url = $"https://api.music.yandex.net/users/{Uri.EscapeDataString(user)}/playlists/{Uri.EscapeDataString(kind)}";
    using var response = await http.GetAsync(url);
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode)
    {
        return new HelperResult(false, $"Yandex API HTTP {(int)response.StatusCode}", "yandex", null);
    }

    using var doc = JsonDocument.Parse(body);
    if (!doc.RootElement.TryGetProperty("result", out var playlist))
    {
        return new HelperResult(false, "Yandex API returned no playlist result", "yandex", null);
    }

    var name = playlist.TryGetProperty("title", out var titleEl) ? titleEl.GetString() : "Yandex Playlist";
    var tracks = new List<HelperTrack>();
    if (playlist.TryGetProperty("tracks", out var rows) && rows.ValueKind == JsonValueKind.Array)
    {
        foreach (var row in rows.EnumerateArray())
        {
            var track = row.TryGetProperty("track", out var nested) ? nested : row;
            var title = track.TryGetProperty("title", out var t) ? t.GetString() : null;
            if (string.IsNullOrWhiteSpace(title)) continue;

            var artists = new List<string>();
            if (track.TryGetProperty("artists", out var artistsEl) && artistsEl.ValueKind == JsonValueKind.Array)
            {
                artists.AddRange(artistsEl.EnumerateArray()
                    .Select(a => a.TryGetProperty("name", out var n) ? n.GetString() : null)
                    .Where(s => !string.IsNullOrWhiteSpace(s))!);
            }

            tracks.Add(new HelperTrack(
                title.Trim(),
                artists.Count > 0 ? string.Join(", ", artists) : "-",
                track.TryGetProperty("durationMs", out var d) && d.TryGetInt32(out var ms) ? Math.Max(1, ms / 1000) : null,
                track.TryGetProperty("id", out var id) ? id.ToString() : null,
                track.TryGetProperty("coverUri", out var cover) ? NormalizeCover(cover.GetString()) : null));
        }
    }

    return new HelperResult(true, null, "yandex", new HelperPlaylist(name ?? "Yandex Playlist", tracks));
}

static HelperResult? PlaylistToResult(object? playlist, string fallbackName)
{
    if (playlist is null) return null;
    var title = GetStringProperty(playlist, "Title") ?? GetStringProperty(playlist, "Name") ?? fallbackName;
    var rows = GetEnumerableProperty(playlist, "Tracks") ?? GetEnumerableProperty(playlist, "TrackIds");
    if (rows is null) return new HelperResult(true, null, "yandex", new HelperPlaylist(title, []));

    var tracks = new List<HelperTrack>();
    foreach (var row in rows)
    {
        var track = GetPropertyValue(row, "Track") ?? row;
        var trackTitle = GetStringProperty(track, "Title");
        if (string.IsNullOrWhiteSpace(trackTitle)) continue;
        tracks.Add(new HelperTrack(
            trackTitle.Trim(),
            GetArtists(track),
            GetDurationSeconds(track),
            GetStringProperty(track, "Id") ?? GetStringProperty(track, "RealId"),
            NormalizeCover(GetStringProperty(track, "CoverUri"))));
    }

    return new HelperResult(true, null, "yandex", new HelperPlaylist(title, tracks));
}

static object? GetBranch(Type rootType, string name)
{
    const BindingFlags flags = BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance;
    var prop = rootType.GetProperty(name, flags);
    if (prop is not null) return prop.GetValue(prop.GetGetMethod()?.IsStatic == true ? null : Activator.CreateInstance(rootType));
    var field = rootType.GetField(name, flags);
    if (field is not null) return field.GetValue(field.IsStatic ? null : Activator.CreateInstance(rootType));
    return null;
}

static async Task<object?> InvokeMaybeAsync(object target, string[] names, params object?[] args)
{
    var type = target as Type ?? target.GetType();
    var flags = BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance;
    var method = type.GetMethods(flags)
        .FirstOrDefault(m => names.Contains(m.Name, StringComparer.OrdinalIgnoreCase) && m.GetParameters().Length == args.Length);
    if (method is null) return null;

    var instance = method.IsStatic ? null : target;
    var value = method.Invoke(instance, args);
    if (value is Task task)
    {
        await task.ConfigureAwait(false);
        var resultProp = task.GetType().GetProperty("Result");
        return resultProp?.GetValue(task);
    }
    return value;
}

static IEnumerable<Type> SafeGetTypes(Assembly assembly)
{
    try { return assembly.GetTypes(); }
    catch (ReflectionTypeLoadException ex) { return ex.Types.Where(t => t is not null)!; }
}

static object? GetPropertyValue(object? obj, string name)
{
    if (obj is null) return null;
    return obj.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase)?.GetValue(obj);
}

static string? GetStringProperty(object? obj, string name) => GetPropertyValue(obj, name)?.ToString();

static IEnumerable? GetEnumerableProperty(object? obj, string name) => GetPropertyValue(obj, name) as IEnumerable;

static string GetArtists(object track)
{
    var artists = GetEnumerableProperty(track, "Artists");
    if (artists is null) return "-";
    var names = artists.Cast<object?>()
        .Select(a => GetStringProperty(a, "Name"))
        .Where(s => !string.IsNullOrWhiteSpace(s))
        .ToArray();
    return names.Length > 0 ? string.Join(", ", names) : "-";
}

static int? GetDurationSeconds(object track)
{
    var raw = GetPropertyValue(track, "DurationMs") ?? GetPropertyValue(track, "Duration");
    if (raw is null) return null;
    return int.TryParse(raw.ToString(), out var value) ? Math.Max(1, value > 10000 ? value / 1000 : value) : null;
}

static string? NormalizeCover(string? coverUri)
{
    if (string.IsNullOrWhiteSpace(coverUri)) return null;
    var value = coverUri.Replace("%%", "300x300");
    return value.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? value : "https://" + value.TrimStart('/');
}

static bool TryParseYandexPlaylistRef(string input, [NotNullWhen(true)] out string? user, [NotNullWhen(true)] out string? kind)
{
    user = null;
    kind = null;
    var raw = input.Trim();
    if (!raw.Contains("://", StringComparison.Ordinal)) raw = "https://" + raw;
    if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)) return false;
    if (!uri.Host.Contains("music.yandex.", StringComparison.OrdinalIgnoreCase)) return false;
    var parts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
    var usersIdx = Array.FindIndex(parts, p => p.Equals("users", StringComparison.OrdinalIgnoreCase));
    if (usersIdx < 0 || usersIdx + 3 >= parts.Length || !parts[usersIdx + 2].Equals("playlists", StringComparison.OrdinalIgnoreCase)) return false;
    user = Uri.UnescapeDataString(parts[usersIdx + 1]);
    kind = Uri.UnescapeDataString(parts[usersIdx + 3]);
    return !string.IsNullOrWhiteSpace(user) && !string.IsNullOrWhiteSpace(kind);
}

static void WriteJson(HelperResult result)
{
    Console.OutputEncoding = System.Text.Encoding.UTF8;
    Console.WriteLine(JsonSerializer.Serialize(result, CreateJsonOptions()));
}

static JsonSerializerOptions CreateJsonOptions() => new()
{
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = false,
};

internal sealed record HelperOptions(string? PlaylistUrl, bool ShowHelp)
{
    public static HelperOptions Parse(string[] args)
    {
        string? playlistUrl = null;
        var showHelp = false;
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg is "-h" or "--help")
            {
                showHelp = true;
            }
            else if (arg is "--playlist-url" or "--url")
            {
                playlistUrl = i + 1 < args.Length ? args[++i] : null;
            }
        }
        return new HelperOptions(playlistUrl, showHelp);
    }
}

internal sealed record HelperResult(bool Ok, string? Error, string? Service, HelperPlaylist? Playlist);
internal sealed record HelperPlaylist(string Name, List<HelperTrack> Tracks);
internal sealed record HelperTrack(string Title, string Artist, int? Duration, string? OriginalId, string? Cover);

<?php
// Renders every generated component with the real Blade engine, as a Laravel app
// would (<x-case0 class="..." />), and checks that the SVG text comes out exactly
// as it went in and that attributes are forwarded. Exits non-zero on failure.
require __DIR__ . '/vendor/autoload.php';

use Illuminate\Container\Container;
use Illuminate\Events\Dispatcher;
use Illuminate\Filesystem\Filesystem;
use Illuminate\View\Compilers\BladeCompiler;
use Illuminate\View\Engines\CompilerEngine;
use Illuminate\View\Engines\EngineResolver;
use Illuminate\View\Factory;
use Illuminate\View\FileViewFinder;

class App extends Container
{
    public function getNamespace()
    {
        return 'App\\';
    }
}

$build = __DIR__ . '/build';
$app = new App();
Container::setInstance($app);
$files = new Filesystem();
@mkdir("$build/cache");
$compiler = new BladeCompiler($files, "$build/cache");
$engines = new EngineResolver();
$engines->register('blade', fn () => new CompilerEngine($compiler, $files));
$views = new Factory($engines, new FileViewFinder($files, ["$build/views"]), new Dispatcher($app));
$views->addExtension('blade.php', 'blade');
$app->instance(\Illuminate\Contracts\View\Factory::class, $views);
$app->alias(\Illuminate\Contracts\View\Factory::class, 'view');
$app->instance(\Illuminate\Contracts\Foundation\Application::class, $app);

function render(Factory $views, string $build, string $name, string $tag): string
{
    file_put_contents("$build/views/page-$name.blade.php", $tag);
    return $views->make("page-$name")->render();
}

$failures = 0;
foreach (json_decode(file_get_contents("$build/cases.json")) as $i => $text) {
    $html = render($views, $build, "case$i", "<x-case$i class=\"size-6\" data-test=\"1\" />");
    preg_match('#<text>(.*)</text>#s', $html, $m);
    $ok = ($m[1] ?? null) === $text && str_contains($html, 'class="size-6"') && str_contains($html, 'data-test="1"');
    echo ($ok ? 'ok   ' : 'FAIL ') . json_encode($text) . ($ok ? '' : ' -> ' . json_encode($m[1] ?? $html)) . "\n";
    $failures += $ok ? 0 : 1;
}
$real = render($views, $build, 'real', '<x-real class="size-6" />');
$realOk = trim($real) === file_get_contents("$build/real.expected.svg");
echo ($realOk ? 'ok   ' : 'FAIL ') . "python.svg renders\n";
$failures += $realOk ? 0 : 1;

echo "failures: $failures\n";
exit($failures ? 1 : 0);

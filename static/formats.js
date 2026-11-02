/* SVG Recolor — code formats.
 *
 * Each format turns the recolored SVG into ready-to-paste code for a language or
 * framework. To add one, add an entry to FORMATS: an id, a label, a group, an
 * icon, the file name to save as, a usage hint and a `code(svg, h)` function.
 *
 * Brand icons: Simple Icons (https://simpleicons.org), CC0. Brand colors are shown
 * only on hover and for the selected format; dark brands fall back to the text color.
 */
(function (global) {
    'use strict';

    // [path, brand color or null] on a 24x24 grid, filled.
    const BRAND = {"angular":["M16.712 17.711H7.288l-1.204 2.916L12 24l5.916-3.373-1.204-2.916ZM14.692 0l7.832 16.855.814-12.856L14.692 0ZM9.308 0 .662 3.999l.814 12.856L9.308 0Zm-.405 13.93h6.198L12 6.396 8.903 13.93Z",null],"astro":["M8.358 20.162c-1.186-1.07-1.532-3.316-1.038-4.944.856 1.026 2.043 1.352 3.272 1.535 1.897.283 3.76.177 5.522-.678.202-.098.388-.229.608-.36.166.473.209.95.151 1.437-.14 1.185-.738 2.1-1.688 2.794-.38.277-.782.525-1.175.787-1.205.804-1.531 1.747-1.078 3.119l.044.148a3.158 3.158 0 0 1-1.407-1.188 3.31 3.31 0 0 1-.544-1.815c-.004-.32-.004-.642-.048-.958-.106-.769-.472-1.113-1.161-1.133-.707-.02-1.267.411-1.415 1.09-.012.053-.028.104-.045.165h.002zm-5.961-4.445s3.24-1.575 6.49-1.575l2.451-7.565c.092-.366.36-.614.662-.614.302 0 .57.248.662.614l2.45 7.565c3.85 0 6.491 1.575 6.491 1.575L16.088.727C15.93.285 15.663 0 15.303 0H8.697c-.36 0-.615.285-.784.727l-5.516 14.99z","BC52EE"],"blazor":["M23.8337 8.1013a13.9123 13.9123 0 0 1-13.6424 11.72 10.1053 10.1053 0 0 1-1.994-.121 6.111 6.111 0 0 1-5.0824-5.7607 5.9344 5.9344 0 0 1 11.867-.0838c.025.9835-.4011 1.8464-1.277 1.8713-.9356 0-1.3742-.6677-1.3742-1.5674v-2.5001a1.5313 1.5313 0 0 0-1.5196-1.5328H8.7152a3.6481 3.6481 0 1 0 2.6948 6.0794l.0733-.1093.0734.1213a2.5807 2.5807 0 0 0 2.2007 1.0479 2.9088 2.9088 0 0 0 2.6947-3.0406 7.912 7.912 0 0 0-.217-1.9324 7.4043 7.4043 0 0 0-14.6395 1.6033 7.4971 7.4971 0 0 0 7.307 7.4043s.549.05 1.1677.0357a15.8029 15.8029 0 0 0 8.4747-2.5283c.036-.025.0719.025.048.0614a12.4392 12.4392 0 0 1-9.6901 3.9625A8.7442 8.7442 0 0 1 .003 13.8603a9.049 9.049 0 0 1 3.6349-7.2471 8.8634 8.8634 0 0 1 5.229-1.7262h2.813a7.9145 7.9145 0 0 0 5.8386-2.5777.1093.1093 0 0 1 .0594-.034.1115.1115 0 0 1 .1195.0522.113.113 0 0 1 .0155.0672 7.9345 7.9345 0 0 1-1.2274 3.5493.1075.1075 0 0 0-.0132.0609.1098.1098 0 0 0 .0724.0945.109.109 0 0 0 .0619.0033 8.5054 8.5054 0 0 0 5.9134-4.876.1554.1554 0 0 1 .0546-.0527.1497.1497 0 0 1 .147 0 .1535.1535 0 0 1 .0546.0527 10.779 10.779 0 0 1 1.0575 6.8746zm-14.9383 3.527a2.188 2.188 0 1 0 2.1877 2.1878v-2.0425a.1577.1577 0 0 0-.1497-.1497Z","512BD4"],"css3":["M1.5 0h21l-1.91 21.563L11.977 24l-8.565-2.438L1.5 0zm17.09 4.413L5.41 4.41l.213 2.622 10.125.002-.255 2.716h-6.64l.24 2.573h6.182l-.366 3.523-2.91.804-2.956-.81-.188-2.11h-2.61l.29 3.855L12 19.288l5.373-1.53L18.59 4.414z","1572B6"],"django":["M11.146 0h3.924v18.166c-2.013.382-3.491.535-5.096.535-4.791 0-7.288-2.166-7.288-6.32 0-4.002 2.65-6.6 6.753-6.6.637 0 1.121.05 1.707.203zm0 9.143a3.894 3.894 0 00-1.325-.204c-1.988 0-3.134 1.223-3.134 3.365 0 2.09 1.096 3.236 3.109 3.236.433 0 .79-.025 1.35-.102V9.142zM21.314 6.06v9.098c0 3.134-.229 4.638-.917 5.937-.637 1.249-1.478 2.039-3.211 2.905l-3.644-1.733c1.733-.815 2.574-1.53 3.109-2.625.561-1.121.739-2.421.739-5.835V6.059h3.924zM17.39.021h3.924v4.026H17.39z",null],"flutter":["M14.314 0L2.3 12 6 15.7 21.684.013h-7.357zm.014 11.072L7.857 17.53l6.47 6.47H21.7l-6.46-6.468 6.46-6.46h-7.37z","02569B"],"html5":["M1.5 0h21l-1.91 21.563L11.977 24l-8.564-2.438L1.5 0zm7.031 9.75l-.232-2.718 10.059.003.23-2.622L5.412 4.41l.698 8.01h9.126l-.326 3.426-2.91.804-2.955-.81-.188-2.11H6.248l.33 4.171L12 19.351l5.379-1.443.744-8.157H8.531z","E34F26"],"laravel":["M23.642 5.43a.364.364 0 01.014.1v5.149c0 .135-.073.26-.189.326l-4.323 2.49v4.934a.378.378 0 01-.188.326L9.93 23.949a.316.316 0 01-.066.027c-.008.002-.016.008-.024.01a.348.348 0 01-.192 0c-.011-.002-.02-.008-.03-.012-.02-.008-.042-.014-.062-.025L.533 18.755a.376.376 0 01-.189-.326V2.974c0-.033.005-.066.014-.098.003-.012.01-.02.014-.032a.369.369 0 01.023-.058c.004-.013.015-.022.023-.033l.033-.045c.012-.01.025-.018.037-.027.014-.012.027-.024.041-.034H.53L5.043.05a.375.375 0 01.375 0L9.93 2.647h.002c.015.01.027.021.04.033l.038.027c.013.014.02.03.033.045.008.011.02.021.025.033.01.02.017.038.024.058.003.011.01.021.013.032.01.031.014.064.014.098v9.652l3.76-2.164V5.527c0-.033.004-.066.013-.098.003-.01.01-.02.013-.032a.487.487 0 01.024-.059c.007-.012.018-.02.025-.033.012-.015.021-.03.033-.043.012-.012.025-.02.037-.028.014-.01.026-.023.041-.032h.001l4.513-2.598a.375.375 0 01.375 0l4.513 2.598c.016.01.027.021.042.031.012.01.025.018.036.028.013.014.022.03.034.044.008.012.019.021.024.033.011.02.018.04.024.06.006.01.012.021.015.032zm-.74 5.032V6.179l-1.578.908-2.182 1.256v4.283zm-4.51 7.75v-4.287l-2.147 1.225-6.126 3.498v4.325zM1.093 3.624v14.588l8.273 4.761v-4.325l-4.322-2.445-.002-.003H5.04c-.014-.01-.025-.021-.04-.031-.011-.01-.024-.018-.035-.027l-.001-.002c-.013-.012-.021-.025-.031-.04-.01-.011-.021-.022-.028-.036h-.002c-.008-.014-.013-.031-.02-.047-.006-.016-.014-.027-.018-.043a.49.49 0 01-.008-.057c-.002-.014-.006-.027-.006-.041V5.789l-2.18-1.257zM5.23.81L1.47 2.974l3.76 2.164 3.758-2.164zm1.956 13.505l2.182-1.256V3.624l-1.58.91-2.182 1.255v9.435zm11.581-10.95l-3.76 2.163 3.76 2.163 3.759-2.164zm-.376 4.978L16.21 7.087 14.63 6.18v4.283l2.182 1.256 1.58.908zm-8.65 9.654l5.514-3.148 2.756-1.572-3.757-2.163-4.323 2.489-3.941 2.27z","FF2D20"],"lit":["M2.4 9.6l4.8 4.8V24l-4.8-4.8V9.6zm4.8-4.8v9.6L12 9.6V0L7.2 4.8zM12 9.6v9.6l4.8-4.8V4.8L12 9.6zm4.8 4.8V24l4.8-4.8V9.6l-4.8 4.8z","324FFF"],"markdown":["M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z",null],"python":["M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z","3776AB"],"react":["M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z","61DAFB"],"solid":["M11.558.788A9.082 9.082 0 0 0 9.776.99l-.453.15c-.906.303-1.656.755-2.1 1.348l-.301.452-2.035 3.528c.426-.387.974-.698 1.643-.894h.001l.613-.154h.001a8.82 8.82 0 0 1 1.777-.206c2.916-.053 6.033 1.148 8.423 2.36 2.317 1.175 3.888 2.32 3.987 2.39L24 5.518c-.082-.06-1.66-1.21-3.991-2.386-2.393-1.206-5.521-2.396-8.45-2.343zM8.924 5.366a8.634 8.634 0 0 0-1.745.203l-.606.151c-1.278.376-2.095 1.16-2.43 2.108-.334.948-.188 2.065.487 3.116.33.43.747.813 1.216 1.147L12.328 10h.001a6.943 6.943 0 0 1 6.013 1.013l2.844-.963c-.17-.124-1.663-1.2-3.91-2.34-2.379-1.206-5.479-2.396-8.352-2.344zm5.435 4.497a6.791 6.791 0 0 0-1.984.283L2.94 13.189 0 18.334l9.276-2.992a6.945 6.945 0 0 1 7.408 2.314v.001c.695.903.89 1.906.66 2.808l2.572-4.63c.595-1.041.45-2.225-.302-3.429a6.792 6.792 0 0 0-5.255-2.543zm-3.031 5.341a6.787 6.787 0 0 0-2.006.283L.008 18.492c.175.131 2.02 1.498 4.687 2.768 2.797 1.332 6.37 2.467 9.468 1.712l.454-.152h.002c1.278-.376 2.134-1.162 2.487-2.09.353-.93.207-2.004-.541-2.978a6.791 6.791 0 0 0-5.237-2.548z","2C4F7C"],"streamlit":["M16.673 11.32l6.862-3.618c.233-.136.554.12.442.387L20.463 17.1zm-8.556-.229l3.473-5.187c.203-.328.578-.316.793-.028l7.886 11.75zm-3.375 7.25c-.28 0-.835-.284-.993-.716l-3.72-9.46c-.118-.331.139-.614.48-.464l19.474 10.306c-.149.147-.453.337-.72.334z","FF4B4B"],"svelte":["M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767 4.109 4.109 0 0 1-.703-3.107 3.898 3.898 0 0 1 .134-.522l.105-.321.287.21a7.21 7.21 0 0 0 2.186 1.092l.208.063-.02.208a1.253 1.253 0 0 0 .226.83 1.337 1.337 0 0 0 1.435.533 1.231 1.231 0 0 0 .343-.15l5.59-3.562a1.164 1.164 0 0 0 .524-.778 1.242 1.242 0 0 0-.211-.937 1.338 1.338 0 0 0-1.435-.533 1.23 1.23 0 0 0-.343.15l-2.133 1.36a4.078 4.078 0 0 1-1.135.499 4.44 4.44 0 0 1-4.765-1.766 4.108 4.108 0 0 1-.702-3.108 3.855 3.855 0 0 1 1.742-2.582l5.589-3.563a4.072 4.072 0 0 1 1.135-.499 4.44 4.44 0 0 1 4.765 1.767 4.109 4.109 0 0 1 .703 3.107 3.943 3.943 0 0 1-.134.522l-.105.321-.286-.21a7.204 7.204 0 0 0-2.187-1.093l-.208-.063.02-.207a1.255 1.255 0 0 0-.226-.831 1.337 1.337 0 0 0-1.435-.532 1.231 1.231 0 0 0-.343.15L8.62 9.368a1.162 1.162 0 0 0-.524.778 1.24 1.24 0 0 0 .211.937 1.338 1.338 0 0 0 1.435.533 1.235 1.235 0 0 0 .344-.151l2.132-1.36a4.067 4.067 0 0 1 1.135-.498 4.44 4.44 0 0 1 4.765 1.766 4.108 4.108 0 0 1 .702 3.108 3.857 3.857 0 0 1-1.742 2.583l-5.589 3.562a4.072 4.072 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.412 6.412 0 0 0-2.896 4.295 6.753 6.753 0 0 0 .666 4.336 6.43 6.43 0 0 0-.96 2.396 6.833 6.833 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.41 6.41 0 0 0 2.896-4.295 6.756 6.756 0 0 0-.665-4.336 6.429 6.429 0 0 0 .958-2.396 6.831 6.831 0 0 0-1.167-5.168Z","FF3E00"],"svg":["M12 0c-1.497 0-2.749.965-3.248 2.17a3.45 3.45 0 00-.238 1.416 3.459 3.459 0 00-1.168-.834 3.508 3.508 0 00-1.463-.256 3.513 3.513 0 00-2.367 1.02c-1.06 1.058-1.263 2.625-.764 3.83.179.432.47.82.82 1.154a3.49 3.49 0 00-1.402.252C.965 9.251 0 10.502 0 12c0 1.497.965 2.749 2.17 3.248.437.181.924.25 1.414.236-.357.338-.65.732-.832 1.17-.499 1.205-.295 2.772.764 3.83 1.058 1.06 2.625 1.263 3.83.764.437-.181.83-.476 1.168-.832-.014.49.057.977.238 1.414C9.251 23.035 10.502 24 12 24c1.497 0 2.749-.965 3.248-2.17a3.45 3.45 0 00.238-1.416c.338.356.73.653 1.168.834 1.205.499 2.772.295 3.83-.764 1.06-1.058 1.263-2.625.764-3.83a3.459 3.459 0 00-.834-1.168 3.45 3.45 0 001.416-.238C23.035 14.749 24 13.498 24 12c0-1.497-.965-2.749-2.17-3.248a3.455 3.455 0 00-1.414-.236c.357-.338.65-.732.832-1.17.499-1.205.295-2.772-.764-3.83a3.513 3.513 0 00-2.367-1.02 3.508 3.508 0 00-1.463.256c-.437.181-.83.475-1.168.832a3.45 3.45 0 00-.238-1.414C14.749.965 13.498 0 12 0zm-.041 1.613a1.902 1.902 0 011.387 3.246v3.893L16.098 6A1.902 1.902 0 1118 7.902l-2.752 2.752h3.893a1.902 1.902 0 110 2.692h-3.893L18 16.098A1.902 1.902 0 1116.098 18l-2.752-2.752v3.893a1.902 1.902 0 11-2.692 0v-3.893L7.902 18A1.902 1.902 0 116 16.098l2.752-2.752H4.859a1.902 1.902 0 110-2.692h3.893L6 7.902A1.902 1.902 0 117.902 6l2.752 2.752V4.859a1.902 1.902 0 011.305-3.246z","FFB13B"],"tailwindcss":["M12.001,4.8c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 C13.666,10.618,15.027,12,18.001,12c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C16.337,6.182,14.976,4.8,12.001,4.8z M6.001,12c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 c1.177,1.194,2.538,2.576,5.512,2.576c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C10.337,13.382,8.976,12,6.001,12z","06B6D4"],"typescript":["M1.125 0C.502 0 0 .502 0 1.125v21.75C0 23.498.502 24 1.125 24h21.75c.623 0 1.125-.502 1.125-1.125V1.125C24 .502 23.498 0 22.875 0zm17.363 9.75c.612 0 1.154.037 1.627.111a6.38 6.38 0 0 1 1.306.34v2.458a3.95 3.95 0 0 0-.643-.361 5.093 5.093 0 0 0-.717-.26 5.453 5.453 0 0 0-1.426-.2c-.3 0-.573.028-.819.086a2.1 2.1 0 0 0-.623.242c-.17.104-.3.229-.393.374a.888.888 0 0 0-.14.49c0 .196.053.373.156.529.104.156.252.304.443.444s.423.276.696.41c.273.135.582.274.926.416.47.197.892.407 1.266.628.374.222.695.473.963.753.268.279.472.598.614.957.142.359.214.776.214 1.253 0 .657-.125 1.21-.373 1.656a3.033 3.033 0 0 1-1.012 1.085 4.38 4.38 0 0 1-1.487.596c-.566.12-1.163.18-1.79.18a9.916 9.916 0 0 1-1.84-.164 5.544 5.544 0 0 1-1.512-.493v-2.63a5.033 5.033 0 0 0 3.237 1.2c.333 0 .624-.03.872-.09.249-.06.456-.144.623-.25.166-.108.29-.234.373-.38a1.023 1.023 0 0 0-.074-1.089 2.12 2.12 0 0 0-.537-.5 5.597 5.597 0 0 0-.807-.444 27.72 27.72 0 0 0-1.007-.436c-.918-.383-1.602-.852-2.053-1.405-.45-.553-.676-1.222-.676-2.005 0-.614.123-1.141.369-1.582.246-.441.58-.804 1.004-1.089a4.494 4.494 0 0 1 1.47-.629 7.536 7.536 0 0 1 1.77-.201zm-15.113.188h9.563v2.166H9.506v9.646H6.789v-9.646H3.375z","3178C6"],"vuedotjs":["M24,1.61H14.06L12,5.16,9.94,1.61H0L12,22.39ZM12,14.08,5.16,2.23H9.59L12,6.41l2.41-4.18h4.43Z","4FC08D"],"webcomponentsdotorg":["M11.731 2.225l-.01.016H5.618L0 11.979l5.618 9.736h12.8l.04.06 2.134-3.735.518-.893h-.008l.008-.014-.626-.75h.895l.006-.01.008.01L24 11.994l-2.607-4.39-.003.005-.011-.02h-.945l.63-.763-2.606-4.57-.006.01-.024-.04H11.73zM9.107 6.824h6.19l-.53.764h-.023l2.398 4.015h.875l-.277.328.357.435h-.956l-2.398 4.015h.027l.523.764H9.074l-2.99-5.168 3.022-5.155z","29ABE2"]};
    // Generic icons (stroked, 24x24), for formats without a brand.
    const GENERIC = {
        datauri: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
        base64: 'M4 4h4v6H4zM16 4h4v6h-4zM4 14h4v6H4zM12 4v6M12 14v6M16 14v6M20 14v6',
    };

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    const clean = (svg) => svg.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!(?:--)[\s\S]*?-->/g, '').trim();
    const indent = (text, n) => text.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');
    const oneLine = (svg) => clean(svg).replace(/\s*\n\s*/g, ' ');
    const dataUri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(oneLine(svg)).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
    const base64 = (svg) => btoa(unescape(encodeURIComponent(svg)));
    const textNodes = (svg) => svg.replace(/<[^>]*>/g, '');
    // Markup that a template language would try to interpret: CSS in <style>,
    // braces or '@' in text. Those formats fall back to injecting the raw string.
    const hasStyle = (svg) => /<style[\s>]/i.test(svg) || /<(?:script)[\s>]/i.test(svg);
    const hasBraces = (svg) => /[{}]/.test(textNodes(svg));
    const templateSafe = (svg) => !hasStyle(svg) && !hasBraces(svg);
    const jsTemplate = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    const addAttr = (svg, attr) => svg.replace(/<svg\b/, '<svg ' + attr);
    const camel = (n) => n.replace(/[-:]([a-z])/g, (m, c) => c.toUpperCase());

    // SVG -> JSX attributes (React style: className, camelCase, style objects).
    function jsxMarkup(svg) {
        return clean(svg).replace(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g, (tag, name, attrs, selfClose) => {
            const fixed = attrs.replace(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*')/g, (a, key, val) => {
                if (key === 'class') return 'className=' + val;
                if (key === 'style') {
                    const obj = val.slice(1, -1).split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
                        const i = d.indexOf(':');
                        return i < 0 ? '' : JSON.stringify(camel(d.slice(0, i).trim())) + ': ' + JSON.stringify(d.slice(i + 1).trim());
                    }).filter(Boolean).join(', ');
                    return 'style={{ ' + obj + ' }}';
                }
                if (/^(data|aria)-/.test(key) || key === 'xmlns' || key.startsWith('xmlns:')) return key + '=' + val;
                return camel(key) + '=' + val;
            });
            return '<' + name + fixed + (selfClose ? ' />' : '>');
        });
    }
    function reactComponent(svg, ts) {
        const sig = ts ? 'props: SVGProps<SVGSVGElement>' : 'props';
        const head = ts ? "import type { SVGProps } from 'react';\n\n" : '';
        if (!templateSafe(svg)) {
            return head + 'const svg = `' + jsTemplate(clean(svg)) + '`;\n\n'
                + '// This SVG has CSS or braces, so it is injected as a string.\nexport default function RecoloredIcon(' + (ts ? 'props: React.HTMLAttributes<HTMLSpanElement>' : 'props') + ') {\n'
                + '  return <span {...props} dangerouslySetInnerHTML={{ __html: svg }} />;\n}\n';
        }
        return head + 'export default function RecoloredIcon(' + sig + ') {\n  return (\n' + indent(addAttr(jsxMarkup(svg), '{...props}'), 4) + '\n  );\n}\n';
    }

    // ------------------------------------------------------------------
    // Formats
    // ------------------------------------------------------------------
    const FORMATS = [
        // Basics
        { id: 'svg', label: 'SVG', group: 'Basics', icon: 'svg', file: 'icon.svg', usage: 'Inline it in HTML or save as a file.',
            code: (s) => s },
        { id: 'html', label: 'HTML <img>', group: 'Basics', icon: 'html5', file: 'icon.html', usage: 'No extra file: the SVG is embedded in the src.',
            code: (s) => '<img src="' + dataUri(s) + '" alt="" width="24" height="24">' },
        { id: 'css', label: 'CSS', group: 'Basics', icon: 'css3', file: 'icon.css', usage: 'Add class="icon" to any element.',
            code: (s) => '.icon {\n  width: 24px;\n  height: 24px;\n  background: url("' + dataUri(s) + '") center / contain no-repeat;\n}' },
        { id: 'tailwind', label: 'Tailwind', group: 'Basics', icon: 'tailwindcss', file: 'icon.html', usage: 'Uses an arbitrary background-image value.',
            code: (s) => '<span class="inline-block size-6 bg-contain bg-center bg-no-repeat bg-[url(\'' + dataUri(s) + '\')]"></span>' },
        { id: 'datauri', label: 'Data URI', group: 'Basics', generic: 'datauri', file: 'icon.txt', usage: 'Use as an src, href or CSS url().',
            code: (s) => dataUri(s) },
        { id: 'base64', label: 'Base64', group: 'Basics', generic: 'base64', file: 'icon.b64.txt', usage: 'For data:image/svg+xml;base64,… or APIs that want Base64.',
            code: (s) => base64(s) },
        { id: 'markdown', label: 'Markdown', group: 'Basics', icon: 'markdown', file: 'icon.md', usage: 'Works where Markdown allows data URIs.',
            code: (s) => '![Icon](' + dataUri(s) + ')' },

        // JavaScript
        { id: 'react', label: 'React', group: 'JavaScript', icon: 'react', file: 'RecoloredIcon.jsx', usage: '<RecoloredIcon className="size-6" />',
            code: (s) => reactComponent(s, false) },
        { id: 'react-ts', label: 'React (TS)', group: 'JavaScript', icon: 'typescript', file: 'RecoloredIcon.tsx', usage: '<RecoloredIcon className="size-6" />',
            code: (s) => reactComponent(s, true) },
        { id: 'react-native', label: 'React Native', group: 'JavaScript', icon: 'react', file: 'RecoloredIcon.jsx', usage: 'Needs react-native-svg. <RecoloredIcon width={24} height={24} />',
            code: (s) => "import { SvgXml } from 'react-native-svg';\n\nconst xml = `" + jsTemplate(clean(s)) + "`;\n\nexport default function RecoloredIcon(props) {\n  return <SvgXml xml={xml} {...props} />;\n}\n" },
        { id: 'vue', label: 'Vue', group: 'JavaScript', icon: 'vuedotjs', file: 'RecoloredIcon.vue', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => templateSafe(s)
                ? '<template>\n' + indent(clean(s), 2) + '\n</template>\n'
                : '<script setup>\nconst svg = `' + jsTemplate(clean(s)) + '`;\n<\/script>\n\n<template>\n  <span v-html="svg" />\n</template>\n' },
        { id: 'svelte', label: 'Svelte', group: 'JavaScript', icon: 'svelte', file: 'RecoloredIcon.svelte', usage: '<RecoloredIcon class="size-6" /> (Svelte 5)',
            code: (s) => templateSafe(s)
                ? '<script>\n  let props = $props();\n<\/script>\n\n' + addAttr(clean(s), '{...props}') + '\n'
                : '<script>\n  let props = $props();\n  const svg = `' + jsTemplate(clean(s)) + '`;\n<\/script>\n\n<span {...props}>{@html svg}</span>\n' },
        { id: 'angular', label: 'Angular', group: 'JavaScript', icon: 'angular', file: 'recolored-icon.component.ts', usage: '<app-recolored-icon />',
            code: (s) => (templateSafe(s) && !/@/.test(textNodes(s)))
                ? "import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-recolored-icon',\n  standalone: true,\n  template: `\n" + indent(jsTemplate(clean(s)), 4) + "\n  `,\n})\nexport class RecoloredIconComponent {}\n"
                : "import { Component, inject } from '@angular/core';\nimport { DomSanitizer } from '@angular/platform-browser';\n\n@Component({\n  selector: 'app-recolored-icon',\n  standalone: true,\n  template: '<span [innerHTML]=\"svg\"></span>',\n})\nexport class RecoloredIconComponent {\n  svg = inject(DomSanitizer).bypassSecurityTrustHtml(`" + jsTemplate(clean(s)) + "`);\n}\n" },
        { id: 'solid', label: 'Solid', group: 'JavaScript', icon: 'solid', file: 'RecoloredIcon.jsx', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => templateSafe(s)
                ? 'export default function RecoloredIcon(props) {\n  return (\n' + indent(addAttr(clean(s), '{...props}'), 4) + '\n  );\n}\n'
                : 'const svg = `' + jsTemplate(clean(s)) + '`;\n\nexport default function RecoloredIcon(props) {\n  return <span {...props} innerHTML={svg} />;\n}\n' },
        { id: 'astro', label: 'Astro', group: 'JavaScript', icon: 'astro', file: 'RecoloredIcon.astro', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => templateSafe(s)
                ? '---\nconst props = Astro.props;\n---\n\n' + addAttr(clean(s), '{...props}') + '\n'
                : '---\nconst svg = `' + jsTemplate(clean(s)) + '`;\n---\n\n<Fragment set:html={svg} />\n' },
        { id: 'lit', label: 'Lit', group: 'JavaScript', icon: 'lit', file: 'recolored-icon.js', usage: '<recolored-icon></recolored-icon>',
            code: (s) => "import { LitElement, html } from 'lit';\n\nclass RecoloredIcon extends LitElement {\n  render() {\n    return html`\n" + indent(jsTemplate(clean(s)), 6) + "\n    `;\n  }\n}\n\ncustomElements.define('recolored-icon', RecoloredIcon);\n" },
        { id: 'webcomponent', label: 'Web Component', group: 'JavaScript', icon: 'webcomponentsdotorg', file: 'recolored-icon.js', usage: 'No framework: <recolored-icon></recolored-icon>',
            code: (s) => 'class RecoloredIcon extends HTMLElement {\n  connectedCallback() {\n    this.innerHTML = `\n' + indent(jsTemplate(clean(s)), 6) + "\n    `;\n  }\n}\n\ncustomElements.define('recolored-icon', RecoloredIcon);\n" },

        // Python
        { id: 'python', label: 'Python', group: 'Python', icon: 'python', file: 'icon.py', usage: 'from icon import RECOLORED_ICON',
            code: (s) => 'RECOLORED_ICON = ' + pyString(clean(s)) + '\n' },
        { id: 'streamlit', label: 'Streamlit', group: 'Python', icon: 'streamlit', file: 'app.py', usage: 'streamlit run app.py',
            code: (s) => 'import base64\n\nimport streamlit as st\n\nICON = ' + pyString(clean(s)) + '\n\nb64 = base64.b64encode(ICON.encode()).decode()\nst.markdown(\n    f\'<img src="data:image/svg+xml;base64,{b64}" width="96">\',\n    unsafe_allow_html=True,\n)\n' },
        { id: 'django', label: 'Django / Jinja', group: 'Python', icon: 'django', file: 'templates/icons/recolored-icon.html', usage: '{% include "icons/recolored-icon.html" %}',
            code: (s) => clean(s) + '\n' },

        // More
        { id: 'blade', label: 'Laravel Blade', group: 'More', icon: 'laravel', file: 'resources/views/components/recolored-icon.blade.php', usage: '<x-recolored-icon class="size-6" />',
            code: (s) => addAttr(clean(s).replace(/\{\{|\{!!|@/g, (m) => '@' + m), '{{ $attributes }}') + '\n' },
        { id: 'flutter', label: 'Flutter', group: 'More', icon: 'flutter', file: 'lib/recolored_icon.dart', usage: 'Needs flutter_svg. Use recoloredIcon() as a widget.',
            code: (s) => "import 'package:flutter/widgets.dart';\nimport 'package:flutter_svg/flutter_svg.dart';\n\nconst recoloredIconSvg = r'''\n" + clean(s).replace(/'''/g, "''\\'") + "\n''';\n\nWidget recoloredIcon({double size = 24}) =>\n    SvgPicture.string(recoloredIconSvg, width: size, height: size);\n" },
        { id: 'blazor', label: 'Blazor', group: 'More', icon: 'blazor', file: 'RecoloredIcon.razor', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => addAttr(clean(s).replace(/@/g, '@@'), '@attributes="AdditionalAttributes"') + '\n\n@code {\n    [Parameter(CaptureUnmatchedValues = true)]\n    public Dictionary<string, object>? AdditionalAttributes { get; set; }\n}\n' },
    ];
    const GROUPS = ['Basics', 'JavaScript', 'Python', 'More'];

    function pyString(s) {
        if (!s.includes('"""') && !/\\$/.test(s)) return '"""\\\n' + s.replace(/\\/g, '\\\\') + '\n"""';
        return JSON.stringify(s);
    }

    function iconSvg(f, size) {
        size = size || 16;
        if (f.generic) {
            return '<svg class="fi" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + GENERIC[f.generic] + '"/></svg>';
        }
        const [path, brand] = BRAND[f.icon];
        return '<svg class="fi" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"' + (brand ? ' style="--brand:#' + brand + '"' : '') + '><path d="' + path + '"/></svg>';
    }

    const byId = Object.fromEntries(FORMATS.map((f) => [f.id, f]));
    global.SvgFormats = {
        list: FORMATS,
        groups: GROUPS,
        get: (id) => byId[id] || byId.svg,
        has: (id) => id in byId,
        icon: iconSvg,
        convert: (id, svg) => (byId[id] || byId.svg).code(svg),
    };
})(typeof window !== 'undefined' ? window : globalThis);
